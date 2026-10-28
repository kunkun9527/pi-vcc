import type { ModelThreshold, PiVccSettings } from "./settings";

/** UI-independent descriptors: the TUI and tests use exactly the same rules. */
export interface PanelScope { provider?: string; modelId?: string }
export type RawConfig = Record<string, unknown>;
export interface ConfigItem {
  id: string;
  label: string;
  description: string;
  modelOnly?: boolean;
  values(current: string): string[];
  read(config: PiVccSettings, scope: PanelScope): string;
  write(raw: RawConfig, value: string, scope: PanelScope): void;
}

const YES = "开启", NO = "关闭", INHERIT = "继承默认";
const TRIGGERS = [INHERIT, "50%", "60%", "65%", "70%", "75%", "80%", "85%", "90%",
  "At 32k", "At 64k", "At 128k", "At 256k", "Reserve 8k", "Reserve 16k", "Reserve 32k", "Reserve 64k"];
const RECENT = [INHERIT, "4k", "8k", "16k", "24k", "32k", "64k"];
const valuesWithCurrent = (choices: string[], current: string) =>
  choices.includes(current) ? choices : [...choices, current];
const isObject = (value: unknown): value is RawConfig =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const size = (num: number): string => Number.isFinite(num) && num % 1000 === 0
  ? `${num / 1000}k` : String(num);
function tokens(value: string): number {
  const match = /^(\d+)(k)?$/u.exec(value);
  if (!match) throw new Error(`无效 Token 数量：${value}`);
  const n = Number(match[1]) * (match[2] ? 1000 : 1);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 10_000_000) throw new Error("Token 数量超出范围");
  return n;
}

function currentModelKey(scope: PanelScope): string {
  if (!scope.modelId) throw new Error("没有当前模型");
  const key = scope.provider ? `${scope.provider}/${scope.modelId}` : scope.modelId;
  if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("无效模型名称");
  return key;
}
function rawThreshold(raw: RawConfig, scope: PanelScope | undefined, create: boolean): RawConfig | undefined {
  if (!scope) {
    if (!isObject(raw.globalThreshold)) {
      if (!create) return undefined;
      raw.globalThreshold = {};
    }
    return raw.globalThreshold as RawConfig;
  }
  const key = currentModelKey(scope);
  if (!isObject(raw.modelThresholds)) {
    if (!create) return undefined;
    raw.modelThresholds = {};
  }
  const map = raw.modelThresholds as RawConfig;
  if (!isObject(map[key])) {
    if (!create) return undefined;
    Object.defineProperty(map, key, { value: {}, configurable: true, writable: true, enumerable: true });
  }
  return map[key] as RawConfig;
}
function prune(raw: RawConfig, scope: PanelScope | undefined): void {
  if (!scope) {
    if (isObject(raw.globalThreshold) && Object.keys(raw.globalThreshold).length === 0) delete raw.globalThreshold;
    return;
  }
  const map = raw.modelThresholds;
  if (!isObject(map)) return;
  const key = currentModelKey(scope);
  if (isObject(map[key]) && Object.keys(map[key]).length === 0) delete map[key];
  if (Object.keys(map).length === 0) delete raw.modelThresholds;
}
function effectiveThreshold(config: PiVccSettings, scope?: PanelScope): ModelThreshold | undefined {
  if (!scope) return config.globalThreshold ?? config.defaultThreshold;
  if (!scope.modelId) return undefined;
  const map = config.modelThresholds;
  const key = scope.provider ? `${scope.provider}/${scope.modelId}` : scope.modelId;
  return map?.[key]; // inherit is intentionally distinct from an explicit per-model override
}
function triggerText(value: ModelThreshold | undefined): string {
  if (!value) return INHERIT;
  if (value.reserveTokens !== undefined) return `Reserve ${size(value.reserveTokens)}`;
  if (value.compactAtTokens !== undefined) return `At ${size(value.compactAtTokens)}`;
  if (value.compactPercent !== undefined) return `${value.compactPercent}%`;
  return INHERIT;
}
function writeTrigger(raw: RawConfig, value: string, scope?: PanelScope): void {
  const t = rawThreshold(raw, scope, value !== INHERIT);
  if (!t) return;
  delete t.reserveTokens; delete t.compactAtTokens; delete t.compactPercent;
  if (value !== INHERIT) {
    if (/^\d+%$/.test(value)) {
      const pct = Number(value.slice(0, -1));
      if (!Number.isInteger(pct) || pct < 1 || pct > 99) throw new Error("百分比必须为 1–99");
      t.compactPercent = pct;
    } else if (value.startsWith("At ")) t.compactAtTokens = tokens(value.slice(3));
    else if (value.startsWith("Reserve ")) t.reserveTokens = tokens(value.slice(8));
    else throw new Error("未知阈值选项");
  }
  prune(raw, scope);
}
function recentText(t: ModelThreshold | undefined): string {
  return typeof t?.keepRecentTokens === "number" ? size(t.keepRecentTokens) : INHERIT;
}
function writeRecent(raw: RawConfig, value: string, scope?: PanelScope): void {
  const t = rawThreshold(raw, scope, value !== INHERIT);
  if (!t) return;
  if (value === INHERIT) delete t.keepRecentTokens;
  else t.keepRecentTokens = tokens(value);
  prune(raw, scope);
}
const toggle = (id: "overrideDefaultCompaction" | "debug" | "jevEnabled", label: string, description: string): ConfigItem => ({
  id, label, description, values: () => [YES, NO],
  read: (config) => config[id] === true ? YES : NO,
  write: (raw, value) => {
    if (value !== YES && value !== NO) throw new Error(`未知选项：${value}`);
    raw[id] = value === YES;
  },
});
const thresholdItem = (scopeType: "global" | "model"): ConfigItem => ({
  id: scopeType === "global" ? "globalTrigger" : "modelTrigger",
  label: scopeType === "global" ? "全局压缩触发阈值" : "当前模型触发阈值",
  description: "继承 = 使用原有配置；百分比按窗口使用率计算，At 为绝对 Token 数，Reserve 为预留 Token 数。",
  modelOnly: scopeType === "model",
  values: current => valuesWithCurrent(TRIGGERS, current),
  read: (config, scope) => triggerText(effectiveThreshold(config, scopeType === "global" ? undefined : scope)),
  write: (raw, value, scope) => writeTrigger(raw, value, scopeType === "global" ? undefined : scope),
});
const recentItem = (scopeType: "global" | "model"): ConfigItem => ({
  id: scopeType === "global" ? "globalRecent" : "modelRecent",
  label: scopeType === "global" ? "全局近期保留 Token" : "当前模型近期保留 Token",
  description: "Pi 原生压缩的近期消息保留设置；pi-vcc 自身优先采用任务边界和上下文预算。",
  modelOnly: scopeType === "model",
  values: current => valuesWithCurrent(RECENT, current),
  read: (config, scope) => recentText(effectiveThreshold(config, scopeType === "global" ? undefined : scope)),
  write: (raw, value, scope) => writeRecent(raw, value, scopeType === "global" ? undefined : scope),
});

export const CONFIG_ITEMS: ConfigItem[] = [
  toggle("overrideDefaultCompaction", "接管默认压缩", "开启：pi-vcc 接管 /compact 和自动压缩；关闭：只处理 /pi-vcc。"),
  thresholdItem("global"),
  thresholdItem("model"),
  recentItem("global"),
  recentItem("model"),
  {
    id: "jevEnabled",
    label: "Jev 评分模式",
    description: "关闭=无网络请求；影子=评分并记录但不改变结果；开启=应用评分。需要 JEVMODEL_API_KEY。环境变量优先。",
    values: () => [NO, "影子", YES],
    read: config => config.jevMode === "shadow" ? "影子"
      : config.jevMode === "active" ? YES
      : config.jevMode === "off" ? NO
      : config.jevEnabled === true ? YES : NO,
    write: (raw, value) => {
      if (value !== NO && value !== YES && value !== "影子") throw new Error("未知 Jev 模式");
      raw.jevMode = value === "影子" ? "shadow" : value === YES ? "active" : "off";
      raw.jevEnabled = value !== NO; // backward-compatible legacy setting
    },
  },
  toggle("debug", "调试日志", "写入调试信息到 /tmp/pi-vcc-debug.json；敏感会话建议关闭。"),
];
export function panelItemsFor(scope: PanelScope): ConfigItem[] {
  return CONFIG_ITEMS.filter(item => !item.modelOnly || Boolean(scope.modelId));
}
export function readPanelValue(config: PiVccSettings, id: string, scope: PanelScope = {}): string {
  const item = CONFIG_ITEMS.find(item => item.id === id);
  if (!item) throw new Error(`未知配置：${id}`);
  return item.read(config, scope);
}
export function applyPanelValue(raw: RawConfig, id: string, value: string, scope: PanelScope = {}): void {
  const item = CONFIG_ITEMS.find(item => item.id === id);
  if (!item) throw new Error(`未知配置：${id}`);
  item.write(raw, value, scope);
}

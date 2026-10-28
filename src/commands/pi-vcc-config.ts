import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { loadSettings, settingsPath, updateSettingsRaw } from "../core/settings";
import { applyPanelValue, panelItemsFor, readPanelValue, type PanelScope } from "../core/config-panel-model";

/** Native Pi SettingsList panel, inspired by billion-context-pi-lean.
 * Changes save synchronously to the same JSON file that every compaction reads.
 * Never rewrites unrelated keys, secrets or unknown model overrides.
 */
export function registerConfigPanel(pi: ExtensionAPI): void {
  pi.registerCommand("pi-vcc-config", {
    description: "Open the interactive pi-vcc configuration panel (全局/当前模型阈值、Jev、日志)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/pi-vcc-config 需要 TUI 模式；可手动编辑 ${settingsPath()}`, "warning");
        return;
      }
      const model = ctx.model as { id?: string; provider?: string } | undefined;
      const scope: PanelScope = { provider: model?.provider, modelId: model?.id };
      const items = panelItemsFor(scope);
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const config = loadSettings();
        const settingItems: SettingItem[] = items.map(item => {
          const value = item.read(config, scope);
          return { id: item.id, label: item.label, description: item.description,
            currentValue: value, values: item.values(value) };
        });
        const container = new Container();
        const selectedModel = scope.modelId
          ? `${scope.provider ? scope.provider + "/" : ""}${scope.modelId}`
          : "未选择模型（隐藏模型专属选项）";
        const jevState = process.env.JEVMODEL_API_KEY ? "已检测到 Key" : "未配置 Key";
        container.addChild(new Text(
          theme.fg("accent", theme.bold("pi-vcc 配置")) +
          theme.fg("dim", `  ${selectedModel}\n保存到：${settingsPath()}\nJev：${jevState}（密钥不会显示）`),
          0, 0,
        ));
        const list = new SettingsList(
          settingItems, Math.min(settingItems.length + 2, 13), getSettingsListTheme(),
          (id, value) => {
            const oldValue = readPanelValue(loadSettings(), id, scope);
            try {
              updateSettingsRaw(raw => applyPanelValue(raw, id, value, scope));
              const savedValue = readPanelValue(loadSettings(), id, scope);
              if (savedValue !== value) list.updateValue(id, savedValue);
              if (id === "jevEnabled" && savedValue !== "关闭" && !process.env.JEVMODEL_API_KEY) {
                ctx.ui.notify("Jev 已设为开启，但未配置 JEVMODEL_API_KEY；仍不会发送请求", "warning");
              }
            } catch (error) {
              list.updateValue(id, oldValue);
              ctx.ui.notify(`pi-vcc 配置保存失败：${error instanceof Error ? error.message : String(error)}`, "error");
            }
            tui.requestRender();
          },
          () => done(undefined),
        );
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ 选择 · Enter 切换选项 · Esc 关闭 · 修改即时保存"), 0, 0));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
        };
      });
    },
  });
}

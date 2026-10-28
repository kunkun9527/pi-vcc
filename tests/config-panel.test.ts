import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CONFIG_ITEMS, applyPanelValue, panelItemsFor, readPanelValue } from "../src/core/config-panel-model";
import { loadSettings, updateSettingsRaw } from "../src/core/settings";
import { jevEnabled } from "../src/core/jev-scorer";
import { registerConfigPanel } from "../src/commands/pi-vcc-config";

const scope = { provider: "neuralwatt", modelId: "zai-org/GLM-5.1" };

describe("TUI config model", () => {
  it("scopes edits to the current provider/model and prunes inherited keys", () => {
    const raw: Record<string, any> = { custom: { kept: true },
      globalThreshold: { compactPercent: 75 }, modelThresholds: { other: { compactPercent: 50 } } };
    applyPanelValue(raw, "modelTrigger", "65%", scope);
    expect(raw.modelThresholds["neuralwatt/zai-org/GLM-5.1"]).toEqual({compactPercent: 65});
    expect(raw.modelThresholds.other.compactPercent).toBe(50);
    applyPanelValue(raw, "modelRecent", "16k", scope);
    expect(raw.modelThresholds["neuralwatt/zai-org/GLM-5.1"].keepRecentTokens).toBe(16000);
    applyPanelValue(raw, "modelTrigger", "Reserve 32k", scope);
    expect(raw.modelThresholds["neuralwatt/zai-org/GLM-5.1"]).toEqual({
      reserveTokens: 32000, keepRecentTokens: 16000,
    });
    applyPanelValue(raw, "modelTrigger", "继承默认", scope);
    expect(raw.modelThresholds["neuralwatt/zai-org/GLM-5.1"]).toEqual({keepRecentTokens: 16000});
    applyPanelValue(raw, "modelRecent", "继承默认", scope);
    expect(raw.modelThresholds["neuralwatt/zai-org/GLM-5.1"]).toBeUndefined();
    expect(raw.modelThresholds.other.compactPercent).toBe(50);
    expect(raw.custom).toEqual({kept:true});
  });
  it("supports absolute token, reserve and percent modes without stale priority fields", () => {
    const raw: Record<string, any> = { globalThreshold: { reserveTokens: 8192 } };
    applyPanelValue(raw, "globalTrigger", "At 128k", scope);
    expect(raw.globalThreshold).toEqual({ compactAtTokens: 128000 });
    applyPanelValue(raw, "globalTrigger", "75%", scope);
    expect(raw.globalThreshold).toEqual({ compactPercent: 75 });
    expect(readPanelValue({...raw, overrideDefaultCompaction:true,debug:false}, "globalTrigger", scope)).toBe("75%");
    applyPanelValue(raw, "globalTrigger", "继承默认", scope);
    expect(raw.globalThreshold).toBeUndefined();
  });
  it("hides model settings without a model and preserves unusual custom values", () => {
    expect(panelItemsFor({}).some(x => x.id === "modelTrigger")).toBe(false);
    expect(panelItemsFor(scope).some(x => x.id === "modelTrigger")).toBe(true);
    const custom = { overrideDefaultCompaction:true,debug:false,
      globalThreshold:{ reserveTokens: 32768 } };
    const text = readPanelValue(custom, "globalTrigger", scope);
    expect(text).toBe("Reserve 32768");
    expect(CONFIG_ITEMS.find(i=>i.id==="globalTrigger")!.values(text)).toContain(text);
    expect(() => applyPanelValue({}, "globalTrigger", "0%", scope)).toThrow();
    expect(() => applyPanelValue({}, "modelTrigger", "65%", {})).toThrow();
  });
});

describe("TUI persistence and real command", () => {
  it("preserves unknown keys and refuses to replace broken JSON", () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-panel-"));
    const file=join(dir,"config.json");
    const previous=process.env.PI_VCC_CONFIG_PATH;
    process.env.PI_VCC_CONFIG_PATH=file;
    try {
      writeFileSync(file,JSON.stringify({custom:{nested:17},overrideDefaultCompaction:true}));
      updateSettingsRaw(raw=>applyPanelValue(raw,"debug","开启",{}));
      const saved=JSON.parse(readFileSync(file,"utf8"));
      expect(saved.debug).toBe(true);
      expect(saved.custom.nested).toBe(17);
      writeFileSync(file,"{broken");
      expect(()=>updateSettingsRaw(raw=>applyPanelValue(raw,"debug","关闭",{}))).toThrow();
      expect(readFileSync(file,"utf8")).toBe("{broken");
    } finally {
      if(previous===undefined) delete process.env.PI_VCC_CONFIG_PATH;
      else process.env.PI_VCC_CONFIG_PATH=previous;
      rmSync(dir,{recursive:true,force:true});
    }
  });
  it("honors saved Jev opt-in, but requires a key and respects env override", () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-panel-"));
    const file=join(dir,"config.json");
    const old={ path:process.env.PI_VCC_CONFIG_PATH, enabled:process.env.PI_VCC_JEV_ENABLED, key:process.env.JEVMODEL_API_KEY };
    process.env.PI_VCC_CONFIG_PATH=file;
    delete process.env.PI_VCC_JEV_ENABLED;
    try {
      updateSettingsRaw(raw=>applyPanelValue(raw,"jevEnabled","开启",{}));
      expect(jevEnabled()).toBe(false);
      process.env.JEVMODEL_API_KEY="test-key";
      expect(jevEnabled()).toBe(true);
      process.env.PI_VCC_JEV_ENABLED="0";
      expect(jevEnabled()).toBe(false);
      process.env.PI_VCC_JEV_ENABLED="1";
      expect(jevEnabled()).toBe(true);
    } finally {
      for(const [key,value] of Object.entries({PI_VCC_CONFIG_PATH:old.path,PI_VCC_JEV_ENABLED:old.enabled,JEVMODEL_API_KEY:old.key}))
        if(value===undefined) delete process.env[key]; else process.env[key]=value;
      rmSync(dir,{recursive:true,force:true});
    }
  });
  it("/pi-vcc-config renders native SettingsList and saves on Enter", async () => {
    const dir=mkdtempSync(join(tmpdir(),"vcc-panel-"));
    const file=join(dir,"config.json");
    const prior=process.env.PI_VCC_CONFIG_PATH;
    process.env.PI_VCC_CONFIG_PATH=file;
    initTheme("dark");
    try {
      let cmd: any, component: any;
      const notices: string[]=[];
      registerConfigPanel({registerCommand:(_name: string,options:any)=>cmd=options} as any);
      expect(cmd).toBeDefined();
      const ctx: any={ mode:"tui", model:{provider:scope.provider,id:scope.modelId},
        ui:{notify:(text:string)=>notices.push(text),
          custom:async (fn:any)=>{component=fn({requestRender(){}},
            {fg:(_c:string,text:string)=>text,bold:(text:string)=>text},{},()=>{});}},
      };
      await cmd.handler("",ctx);
      expect(component.render(110).join("\n")).toContain("pi-vcc 配置");
      expect(component.render(110).join("\n")).toContain(scope.modelId);
      component.handleInput("\r"); // toggle first setting: compaction takeover
      expect(loadSettings().overrideDefaultCompaction).toBe(false);
      expect(notices).toEqual([]);
      const outside: any={mode:"rpc",ui:{notify:(text:string)=>notices.push(text)}};
      await cmd.handler("",outside);
      expect(notices[0]).toContain("TUI");
    } finally {
      if(prior===undefined) delete process.env.PI_VCC_CONFIG_PATH;
      else process.env.PI_VCC_CONFIG_PATH=prior;
      rmSync(dir,{recursive:true,force:true});
    }
  });
});

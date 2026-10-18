import { describe, expect, it } from "vitest";
import { WarningCollector, DECLARED_IGNORED_FIELDS } from "../src/lib/chat/diagnostics.js";
import { t } from "../src/i18n/index.js";

describe("WarningCollector", () => {
  it("accumulates warnings and formats reasons via i18n", () => {
    const collector = new WarningCollector();
    collector.add("presence_penalty", t("warn.ignoredField", { field: "presence_penalty" }));
    collector.add("messages[0].image_url", t("warn.droppedMedia", { type: "image_url" }));

    expect(collector.toArray()).toEqual([
      { field: "presence_penalty", reason: "Field 'presence_penalty' is not supported upstream and was ignored" },
      { field: "messages[0].image_url", reason: "Media block 'image_url' is not supported and was omitted" },
    ]);
  });

  it("exports the list of declared-ignored OpenAI fields", () => {
    expect(DECLARED_IGNORED_FIELDS).toContain("presence_penalty");
    expect(DECLARED_IGNORED_FIELDS).toContain("frequency_penalty");
    expect(DECLARED_IGNORED_FIELDS).toContain("seed");
    expect(DECLARED_IGNORED_FIELDS).toContain("parallel_tool_calls");
  });
});

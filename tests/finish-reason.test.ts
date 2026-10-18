import { describe, expect, it } from "vitest";
import { mapFinishReason } from "../src/lib/chat/turn.js";

describe("mapFinishReason", () => {
  it("maps unknown upstream reasons to 'stop' with a warning", () => {
    const result = mapFinishReason("UNKNOWN_REASON");
    expect(result.reason).toBe("stop");
    expect(result.warning).toMatchObject({
      field: "finish_reason",
      reason: expect.stringContaining("UNKNOWN_REASON"),
    });
  });

  it("maps STOP to stop without warnings", () => {
    const result = mapFinishReason("STOP");
    expect(result.reason).toBe("stop");
    expect(result.warning).toBeUndefined();
  });

  it("maps MAX_TOKENS to length without warnings", () => {
    const result = mapFinishReason("MAX_TOKENS");
    expect(result.reason).toBe("length");
    expect(result.warning).toBeUndefined();
  });

  it("maps SAFETY and RECITATION to content_filter without warnings", () => {
    expect(mapFinishReason("SAFETY")).toEqual({ reason: "content_filter" });
    expect(mapFinishReason("RECITATION")).toEqual({ reason: "content_filter" });
  });

  it("maps undefined or empty reason to stop with a warning", () => {
    const resUndefined = mapFinishReason(undefined);
    expect(resUndefined.reason).toBe("stop");
    expect(resUndefined.warning?.field).toBe("finish_reason");

    const resEmpty = mapFinishReason("");
    expect(resEmpty.reason).toBe("stop");
    expect(resEmpty.warning?.field).toBe("finish_reason");
  });
});

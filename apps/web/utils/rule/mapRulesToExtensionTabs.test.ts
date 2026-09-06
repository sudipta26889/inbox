import { describe, expect, it } from "vitest";
import { getAction, getRule } from "@/__tests__/helpers";
import { ActionType } from "@/generated/prisma/enums";
import { mapRulesToExtensionTabs } from "./mapRulesToExtensionTabs";

// The extension mapper takes the API's rule rows, which carry the rule's group;
// the shared fixture is the bare rule.
function getRuleWithGroup(...args: Parameters<typeof getRule>) {
  return { ...getRule(...args), group: null };
}

describe("mapRulesToExtensionTabs", () => {
  it("maps extension-supported labels to built-in tabs", () => {
    const rules = [
      getRuleWithGroup("sync github", [getAction({ label: "GitHub" })]),
      getRuleWithGroup("sync team", [getAction({ label: "Team" })]),
      getRuleWithGroup("sync stripe", [getAction({ label: "Stripe" })]),
    ];

    expect(mapRulesToExtensionTabs(rules)).toEqual([
      {
        type: "enable_default",
        tabId: "team",
        displayLabel: "Team",
      },
      {
        type: "enable_default",
        tabId: "github",
        displayLabel: "GitHub",
      },
      {
        type: "enable_default",
        tabId: "stripe",
        displayLabel: "Stripe",
      },
    ]);
  });

  it("keeps unsupported labels as custom tabs", () => {
    const rules = [
      getRuleWithGroup("sync travel", [getAction({ label: " Travel " })]),
    ];

    expect(mapRulesToExtensionTabs(rules)).toEqual([
      {
        type: "add_custom",
        label: "Travel",
        icon: "🏷️",
        query: "in:inbox label:travel",
        displayLabel: "Travel",
      },
    ]);
  });

  it("normalizes built-in labels before lookup and dedupe", () => {
    const rules = [
      getRuleWithGroup("sync lowercase team", [getAction({ label: " team " })]),
      getRuleWithGroup("skip duplicate team", [getAction({ label: "TEAM" })]),
    ];

    expect(mapRulesToExtensionTabs(rules)).toEqual([
      {
        type: "enable_default",
        tabId: "team",
        displayLabel: "Team",
      },
    ]);
  });

  it("dedupes built-in labels that only differ by punctuation", () => {
    const rules = [
      getRuleWithGroup("sync follow up", [getAction({ label: "Follow up" })]),
      getRuleWithGroup("skip duplicate follow-up", [
        getAction({ label: "Follow-up" }),
      ]),
    ];

    expect(mapRulesToExtensionTabs(rules)).toEqual([
      {
        type: "enable_default",
        tabId: "follow-up",
        displayLabel: "Follow-up",
      },
    ]);
  });

  it("preserves distinct custom labels that only differ by punctuation", () => {
    const rules = [
      getRuleWithGroup("sync project dotted", [
        getAction({ label: "Project.One" }),
      ]),
      getRuleWithGroup("sync project space", [
        getAction({ label: "Project One" }),
      ]),
    ];

    expect(mapRulesToExtensionTabs(rules)).toEqual([
      {
        type: "add_custom",
        label: "Project One",
        icon: "🏷️",
        query: "in:inbox label:project-one",
        displayLabel: "Project One",
      },
      {
        type: "add_custom",
        label: "Project.One",
        icon: "🏷️",
        query: "in:inbox label:projectone",
        displayLabel: "Project.One",
      },
    ]);
  });

  it("skips labels for archived rules", () => {
    const rules = [
      getRuleWithGroup("archive newsletters", [
        getAction({ label: "Newsletter" }),
        getAction({ type: ActionType.ARCHIVE }),
      ]),
      getRuleWithGroup("keep github visible", [getAction({ label: "GitHub" })]),
    ];

    expect(mapRulesToExtensionTabs(rules)).toEqual([
      {
        type: "enable_default",
        tabId: "github",
        displayLabel: "GitHub",
      },
    ]);
  });
});

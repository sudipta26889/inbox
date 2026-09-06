import { describe, it, expect, vi } from "vitest";
import {
  combineActionsWithAiArgs,
  filterIncompleteDraftActions,
} from "./choose-args";
import { ActionType } from "@/generated/prisma/enums";
import type { DraftAttribution } from "@/utils/ai/reply/draft-attribution";
import { getAction } from "@/__tests__/helpers";

vi.mock("server-only", () => ({}));

describe("combineActionsWithAiArgs", () => {
  describe("DRAFT_EMAIL action with template content", () => {
    it("should replace template variables in content when AI args are provided", () => {
      // This test ensures template variables are replaced with AI-generated content
      const actions = [
        getAction({
          id: "1",
          type: ActionType.DRAFT_EMAIL,
          content: "Dear {{greeting}},\n\n{{draft response}}\n\nBest regards",
        }),
      ];

      const aiArgs = {
        "DRAFT_EMAIL-1": {
          content: {
            var1: "Mr. Johnson",
            var2: "Thank you for your email. I'd be happy to help with your request.",
          },
        },
      };

      const result = combineActionsWithAiArgs(actions, aiArgs, null);

      // Verify that template variables are properly replaced
      expect(result[0].content).toBe(
        "Dear Mr. Johnson,\n\nThank you for your email. I'd be happy to help with your request.\n\nBest regards",
      );
    });

    it("stores attribution for template-generated draft content", () => {
      const actions = [
        getAction({
          id: "draft-template-1",
          type: ActionType.DRAFT_EMAIL,
          content: "Hello {{name}},\n\n{{reply}}",
        }),
      ];

      const aiArgs = {
        "DRAFT_EMAIL-draft-template-1": {
          content: {
            var1: "Taylor",
            var2: "Thanks for the note.",
          },
        },
      };
      const aiArgsAttribution: DraftAttribution = {
        provider: "openai",
        modelName: "gpt-5-mini",
        pipelineVersion: 1,
      };

      const result = combineActionsWithAiArgs(
        actions,
        aiArgs,
        null,
        null,
        aiArgsAttribution,
      );

      expect(result[0]).toMatchObject({
        content: "Hello Taylor,\n\nThanks for the note.",
        draftModelProvider: "openai",
        draftModelName: "gpt-5-mini",
        draftPipelineVersion: 1,
      });
    });

    it("should handle DRAFT_EMAIL action without content (full draft generation)", () => {
      // This test shows the working case where no template exists
      const actions = [
        getAction({
          id: "2",
          type: ActionType.DRAFT_EMAIL,
          content: null,
        }),
      ];

      const fullDraft = "This is a complete AI-generated draft email.";

      const result = combineActionsWithAiArgs(actions, undefined, fullDraft);

      // This case works correctly - the full draft is added
      expect(result[0].content).toBe(fullDraft);
    });

    it("should not skip content field processing when draft exists but action has template", () => {
      // This test ensures that templates with variables are processed even when a draft exists
      const actions = [
        getAction({
          id: "3",
          type: ActionType.DRAFT_EMAIL,
          content: "Hello {{name}}, {{message}}",
        }),
      ];

      const aiArgs = {
        "DRAFT_EMAIL-3": {
          content: {
            var1: "Alice",
            var2: "I hope this email finds you well.",
          },
        },
      };

      // Even if draft is provided, template processing should still happen
      // This draft represents content from another action, not this one
      const draftFromAnotherAction = "Some other draft";

      const result = combineActionsWithAiArgs(
        actions,
        aiArgs,
        draftFromAnotherAction,
      );

      // Verify that template variables are processed correctly
      expect(result[0].content).toBe(
        "Hello Alice, I hope this email finds you well.",
      );
    });
  });

  describe("Other action types with templates", () => {
    it("should process template variables in labels", () => {
      const actions = [
        getAction({
          id: "4",
          type: ActionType.LABEL,
          content: null,
          label: "Priority: {{level}}",
        }),
      ];

      const aiArgs = {
        "LABEL-4": {
          label: {
            var1: "High",
          },
        },
      };

      const result = combineActionsWithAiArgs(actions, aiArgs, null);

      expect(result[0].label).toBe("Priority: High");
    });
  });
});

describe("filterIncompleteDraftActions", () => {
  it("removes draft actions that have no content", () => {
    const result = filterIncompleteDraftActions([
      getAction({
        id: "draft-empty",
        type: ActionType.DRAFT_EMAIL,
        content: null,
      }),
      getAction({
        id: "label-1",
        type: ActionType.LABEL,
        label: "Important",
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe(ActionType.LABEL);
  });

  it("keeps draft actions when content exists", () => {
    const result = filterIncompleteDraftActions([
      getAction({
        id: "draft-filled",
        type: ActionType.DRAFT_EMAIL,
        content: "Thanks for reaching out.",
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("draft-filled");
  });
});

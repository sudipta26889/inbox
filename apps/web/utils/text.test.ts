import { describe, it, expect } from "vitest";
import { slugify } from "./text";

describe("slugify", () => {
  describe("basic transformations", () => {
    it("converts to lowercase", () => {
      expect(slugify("Hello World")).toBe("hello-world");
    });

    it("replaces spaces with hyphens", () => {
      expect(slugify("hello world")).toBe("hello-world");
    });

    it("replaces multiple spaces with single hyphen", () => {
      expect(slugify("hello   world")).toBe("hello-world");
    });

    it("handles already lowercase text", () => {
      expect(slugify("hello")).toBe("hello");
    });
  });

  describe("special characters", () => {
    it("removes special characters", () => {
      expect(slugify("Hello! World?")).toBe("hello-world");
    });

    it("removes punctuation", () => {
      expect(slugify("Hello, World.")).toBe("hello-world");
    });

    it("keeps hyphens", () => {
      expect(slugify("hello-world")).toBe("hello-world");
    });

    it("keeps underscores", () => {
      expect(slugify("hello_world")).toBe("hello_world");
    });

    it("removes apostrophes", () => {
      expect(slugify("it's working")).toBe("its-working");
    });

    it("removes quotes", () => {
      expect(slugify('"hello" world')).toBe("hello-world");
    });

    it("removes parentheses", () => {
      expect(slugify("hello (world)")).toBe("hello-world");
    });

    it("removes ampersands", () => {
      expect(slugify("hello & world")).toBe("hello--world");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(slugify("")).toBe("");
    });

    it("handles numbers", () => {
      expect(slugify("Chapter 1")).toBe("chapter-1");
    });

    it("handles leading/trailing spaces", () => {
      expect(slugify("  hello world  ")).toBe("-hello-world-");
    });

    it("handles tabs", () => {
      expect(slugify("hello\tworld")).toBe("hello-world");
    });

    it("handles newlines", () => {
      expect(slugify("hello\nworld")).toBe("hello-world");
    });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { Model } from "../src/model.js";
import { ClassMorphViolationError, Relation } from "../src/morph-map.js";

class Post extends Model<{ id: string }>()({
  table: "posts",
  primaryKey: "id",
}) {}

class Video extends Model<{ id: string }>()({
  table: "videos",
  primaryKey: "id",
  morphName: "Video",
}) {}

/** Shares `Post`'s table — the collision the alias chain's third rung can't prevent. */
class Draft extends Model<{ id: string }>()({
  table: "posts",
  primaryKey: "id",
}) {}

class Unregistered extends Model<{ id: string }>()({
  table: "unregistereds",
  primaryKey: "id",
}) {}

describe("Morph map", () => {
  afterEach(() => {
    Relation.resetMorphMap();
  });

  describe("the alias chain", () => {
    it("prefers a morph-map entry over everything else", () => {
      Relation.morphMap({ pinned: () => Video });
      expect(Video.morphAlias()).toBe("pinned");
    });

    it("falls back to morphName when unmapped", () => {
      expect(Video.morphAlias()).toBe("Video");
    });

    it("falls back to table when there is no morphName either", () => {
      expect(Post.morphAlias()).toBe("posts");
    });

    it("always resolves, so a plain model needs no declaration", () => {
      expect(Unregistered.morphAlias()).toBe("unregistereds");
    });

    it("cannot disambiguate two models sharing a table without a map", () => {
      // Documents the limitation the map exists to solve: rung 3 is not
      // unique, so both classes resolve to the same discriminant.
      expect(Post.morphAlias()).toBe(Draft.morphAlias());

      Relation.morphMap({ post: () => Post, draft: () => Draft });
      expect(Post.morphAlias()).toBe("post");
      expect(Draft.morphAlias()).toBe("draft");
    });
  });

  describe("morphMap()", () => {
    it("returns the current map when called with no arguments", () => {
      expect(Relation.morphMap()).toEqual({});

      Relation.morphMap({ post: () => Post });
      expect(Object.keys(Relation.morphMap())).toEqual(["post"]);
    });

    it("merges by default", () => {
      Relation.morphMap({ post: () => Post });
      Relation.morphMap({ video: () => Video });

      expect(Object.keys(Relation.morphMap()).sort()).toEqual(["post", "video"]);
    });

    it("replaces wholesale when merge is false", () => {
      Relation.morphMap({ post: () => Post });
      Relation.morphMap({ video: () => Video }, false);

      expect(Object.keys(Relation.morphMap())).toEqual(["video"]);
      expect(Post.morphAlias()).toBe("posts");
    });

    it("lets a re-registration repoint an alias at a different class", () => {
      Relation.morphMap({ thing: () => Post });
      expect(Relation.getMorphedModel("thing")).toBe(Post);

      Relation.morphMap({ thing: () => Video });
      expect(Relation.getMorphedModel("thing")).toBe(Video);
      expect(Video.morphAlias()).toBe("thing");
    });

    it("returns a frozen snapshot, not a live view", () => {
      Relation.morphMap({ post: () => Post });
      const snapshot = Relation.morphMap();

      Relation.morphMap({ video: () => Video });
      expect(Object.keys(snapshot)).toEqual(["post"]);
      expect(Object.isFrozen(snapshot)).toBe(true);
    });
  });

  describe("getMorphedModel()", () => {
    it("resolves a registered alias to its class", () => {
      Relation.morphMap({ post: () => Post });
      expect(Relation.getMorphedModel("post")).toBe(Post);
    });

    it("returns undefined for an unknown alias rather than throwing", () => {
      // A discriminant read off a row is data; stale data should behave
      // like a dangling foreign key, not crash the query.
      expect(Relation.getMorphedModel("nope")).toBeUndefined();
    });

    it("does not invoke thunks until the alias is actually looked up", () => {
      let invoked = 0;
      Relation.morphMap({
        post: () => {
          invoked++;

          return Post;
        },
      });

      expect(invoked).toBe(0);
      Relation.getMorphedModel("post");
      expect(invoked).toBe(1);
    });
  });

  describe("getMorphAlias()", () => {
    it("finds a class whose thunk has never been resolved", () => {
      Relation.morphMap({ post: () => Post, video: () => Video });
      // Nothing has forced either thunk yet — the reverse index is empty
      // and the lookup has to fall back to forcing them.
      expect(Relation.getMorphAlias(Video)).toBe("video");
    });

    it("returns undefined for an unmapped class", () => {
      Relation.morphMap({ post: () => Post });
      expect(Relation.getMorphAlias(Unregistered)).toBeUndefined();
    });
  });

  describe("requireMorphMap()", () => {
    it("throws for an unmapped model instead of falling back", () => {
      Relation.morphMap({ post: () => Post });
      Relation.requireMorphMap();

      expect(() => Unregistered.morphAlias()).toThrow(ClassMorphViolationError);
      expect(() => Unregistered.morphAlias()).toThrow(
        /No morph alias is registered for \[Unregistered\]/,
      );
    });

    it("disables the morphName rung too, not just table", () => {
      Relation.requireMorphMap();
      // Video HAS a morphName; under enforcement that is not enough.
      expect(() => Video.morphAlias()).toThrow(ClassMorphViolationError);
    });

    it("still resolves mapped models", () => {
      Relation.morphMap({ post: () => Post });
      Relation.requireMorphMap();

      expect(Post.morphAlias()).toBe("post");
    });

    it("can be turned back off", () => {
      Relation.requireMorphMap();
      expect(Relation.requiresMorphMap()).toBe(true);

      Relation.requireMorphMap(false);
      expect(Relation.requiresMorphMap()).toBe(false);
      expect(Post.morphAlias()).toBe("posts");
    });
  });

  describe("enforceMorphMap()", () => {
    it("registers and requires in one call", () => {
      Relation.enforceMorphMap({ post: () => Post });

      expect(Post.morphAlias()).toBe("post");
      expect(Relation.requiresMorphMap()).toBe(true);
      expect(() => Video.morphAlias()).toThrow(ClassMorphViolationError);
    });
  });

  describe("resetMorphMap()", () => {
    it("clears the map and the enforcement flag", () => {
      Relation.enforceMorphMap({ post: () => Post });
      Relation.resetMorphMap();

      expect(Relation.morphMap()).toEqual({});
      expect(Relation.requiresMorphMap()).toBe(false);
      expect(Post.morphAlias()).toBe("posts");
    });

    it("clears the reverse index too, not just the forward map", () => {
      Relation.morphMap({ post: () => Post });
      expect(Relation.getMorphAlias(Post)).toBe("post");

      Relation.resetMorphMap();
      expect(Relation.getMorphAlias(Post)).toBeUndefined();
    });
  });

  describe("process-global storage", () => {
    it("is shared across the process, which is why teardown matters", () => {
      // The map is module-level (class metadata, not a service), so it
      // outlives any single Application. This test documents that
      // deliberately: the isolation guarantee is `resetMorphMap()` in
      // afterEach, not per-app scoping.
      Relation.morphMap({ leaky: () => Post });
      expect(Relation.getMorphedModel("leaky")).toBe(Post);
    });

    it("sees no leakage from the previous test's registration", () => {
      expect(Relation.getMorphedModel("leaky")).toBeUndefined();
    });
  });
});

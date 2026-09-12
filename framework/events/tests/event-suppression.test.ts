import { Application } from "@mahiframework/core";
import { describe, expect, it } from "vitest";
import { AbstractEvent, AbstractEvent as Event } from "../src/event.js";
import type { Listener } from "../src/listener.js";
import { EventDispatcher } from "../src/event-dispatcher.js";

class UserRegistered extends AbstractEvent {
  constructor(public readonly email: string) {
    super();
  }
}

class PostCreated extends AbstractEvent {
  get eventName(): string {
    return "model.posts.created";
  }
}

class CommentCreated extends AbstractEvent {
  get eventName(): string {
    return "model.comments.created";
  }
}

describe("Event.suppress() / isSuppressed()", () => {
  it("isSuppressed() is false outside a suppress() callback", () => {
    expect(Event.isSuppressed()).toBe(false);
  });

  it("isSuppressed() is true inside a suppress() callback, false again after it returns", async () => {
    let insideValue: boolean | undefined;

    await Event.suppress(() => {
      insideValue = Event.isSuppressed();
    });

    expect(insideValue).toBe(true);
    expect(Event.isSuppressed()).toBe(false);
  });

  it("EventDispatcher.dispatch() no-ops (no listeners run) while suppressed", async () => {
    const handled: string[] = [];

    class SendWelcomeEmail implements Listener<UserRegistered> {
      handle(event: UserRegistered) {
        handled.push(`welcome:${event.email}`);
      }
    }

    const app = new Application();
    const dispatcher = new EventDispatcher(app);
    dispatcher.listen(UserRegistered, SendWelcomeEmail);

    await Event.suppress(async () => {
      await dispatcher.dispatch(new UserRegistered("a@example.com"));
    });

    expect(handled).toEqual([]);

    // dispatch resumes normally once suppress() has returned
    await dispatcher.dispatch(new UserRegistered("b@example.com"));
    expect(handled).toEqual(["welcome:b@example.com"]);
  });

  it("suppresses dispatch() calls made via nested async calls inside the callback", async () => {
    const handled: string[] = [];

    class SendWelcomeEmail implements Listener<UserRegistered> {
      handle(event: UserRegistered) {
        handled.push(`welcome:${event.email}`);
      }
    }

    const app = new Application();
    const dispatcher = new EventDispatcher(app);
    dispatcher.listen(UserRegistered, SendWelcomeEmail);

    async function nested() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await dispatcher.dispatch(new UserRegistered("nested@example.com"));
    }

    await Event.suppress(async () => {
      await nested();
    });

    expect(handled).toEqual([]);
  });

  it("propagates the callback's return value", async () => {
    const result = await Event.suppress(() => 42);
    expect(result).toBe(42);
  });

  it("still resets isSuppressed() to false if the callback throws", async () => {
    await expect(
      Event.suppress(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(Event.isSuppressed()).toBe(false);
  });

  describe("scoped patterns", () => {
    it("suppress(callback, ['model.posts.*']) only suppresses matching event names", async () => {
      const handled: string[] = [];

      class RecordPostCreated implements Listener<PostCreated> {
        handle() {
          handled.push("post");
        }
      }
      class RecordCommentCreated implements Listener<CommentCreated> {
        handle() {
          handled.push("comment");
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(PostCreated, RecordPostCreated);
      dispatcher.listen(CommentCreated, RecordCommentCreated);

      await Event.suppress(async () => {
        await dispatcher.dispatch(new PostCreated());
        await dispatcher.dispatch(new CommentCreated());
      }, ["model.posts.*"]);

      expect(handled).toEqual(["comment"]);
    });

    it("isSuppressed(name) checks a specific name against the active patterns", async () => {
      await Event.suppress(() => {
        expect(Event.isSuppressed("model.posts.created")).toBe(true);
        expect(Event.isSuppressed("model.comments.created")).toBe(false);
        // isSuppressed() with no argument means "is ANY suppression active"
        expect(Event.isSuppressed()).toBe(true);
      }, ["model.posts.*"]);
    });

    it("nested suppress() calls stack patterns rather than replacing them", async () => {
      const handled: string[] = [];

      class RecordPostCreated implements Listener<PostCreated> {
        handle() {
          handled.push("post");
        }
      }
      class RecordCommentCreated implements Listener<CommentCreated> {
        handle() {
          handled.push("comment");
        }
      }
      class RecordUserRegistered implements Listener<UserRegistered> {
        handle() {
          handled.push("user");
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(PostCreated, RecordPostCreated);
      dispatcher.listen(CommentCreated, RecordCommentCreated);
      dispatcher.listen(UserRegistered, RecordUserRegistered);

      await Event.suppress(async () => {
        await Event.suppress(async () => {
          // both "model.posts.*" (outer) and "model.comments.*" (inner) are active here
          await dispatcher.dispatch(new PostCreated());
          await dispatcher.dispatch(new CommentCreated());
          await dispatcher.dispatch(new UserRegistered("a@example.com"));
        }, ["model.comments.*"]);

        // back to only "model.posts.*" active
        await dispatcher.dispatch(new CommentCreated());
      }, ["model.posts.*"]);

      expect(handled).toEqual(["user", "comment"]);
    });

    it("a bare '*' pattern (the default) suppresses every event name", async () => {
      const handled: string[] = [];

      class RecordPostCreated implements Listener<PostCreated> {
        handle() {
          handled.push("post");
        }
      }

      const app = new Application();
      const dispatcher = new EventDispatcher(app);
      dispatcher.listen(PostCreated, RecordPostCreated);

      await Event.suppress(async () => {
        await dispatcher.dispatch(new PostCreated());
      });

      expect(handled).toEqual([]);
    });
  });

  describe("eventName", () => {
    it("defaults to the constructor name when not overridden", () => {
      expect(new UserRegistered("a@example.com").eventName).toBe("UserRegistered");
    });

    it("can be overridden per subclass", () => {
      expect(new PostCreated().eventName).toBe("model.posts.created");
    });
  });
});

import { Application, setAfterCommitResolver, clearAfterCommitResolver } from "@mahi/core";
import { afterEach, describe, expect, it } from "vitest";
import { AbstractEvent, AbstractEvent as Event } from "../src/event.js";
import type { Listener } from "../src/listener.js";
import { RecordingEventDispatcher } from "../src/recording-event-dispatcher.js";

class PostCreated extends AbstractEvent {
  constructor(public readonly postId: string) {
    super();
  }
}

class PostDeleted extends AbstractEvent {
  constructor(public readonly postId: string) {
    super();
  }
}

describe("RecordingEventDispatcher", () => {
  it("records dispatched events without running any listener", async () => {
    const ran: string[] = [];
    class ShouldNotRun implements Listener<PostCreated> {
      handle() {
        ran.push("listener");
      }
    }

    const dispatcher = new RecordingEventDispatcher(new Application());
    dispatcher.listen(PostCreated, ShouldNotRun);

    await dispatcher.dispatch(new PostCreated("p1"));

    expect(ran).toEqual([]);
    expect(dispatcher.dispatched(PostCreated)).toHaveLength(1);
    expect(dispatcher.dispatched(PostCreated)[0]!.postId).toBe("p1");
  });

  it("does not run afterDispatch callbacks", async () => {
    let afterRan = false;
    const dispatcher = new RecordingEventDispatcher(new Application());
    dispatcher.afterDispatch(() => {
      afterRan = true;
    });

    await dispatcher.dispatch(new PostCreated("p1"));
    expect(afterRan).toBe(false);
  });

  it("dispatched() filters by class and predicate", async () => {
    const dispatcher = new RecordingEventDispatcher(new Application());
    await dispatcher.dispatch(new PostCreated("p1"));
    await dispatcher.dispatch(new PostCreated("p2"));
    await dispatcher.dispatch(new PostDeleted("p1"));

    expect(dispatcher.dispatched()).toHaveLength(3);
    expect(dispatcher.dispatched(PostCreated)).toHaveLength(2);
    expect(dispatcher.dispatched(PostCreated, (e) => e.postId === "p2")).toHaveLength(1);
  });

  it("assertDispatched passes when present, throws when absent", async () => {
    const dispatcher = new RecordingEventDispatcher(new Application());
    await dispatcher.dispatch(new PostCreated("p1"));

    expect(() => dispatcher.assertDispatched(PostCreated)).not.toThrow();
    expect(() => dispatcher.assertDispatched(PostCreated, (e) => e.postId === "p1")).not.toThrow();
    expect(() => dispatcher.assertDispatched(PostDeleted)).toThrow(/PostDeleted.*not/s);
    expect(() => dispatcher.assertDispatched(PostCreated, (e) => e.postId === "nope")).toThrow(
      /matching the given filter/,
    );
  });

  it("assertNotDispatched passes when absent, throws when present", async () => {
    const dispatcher = new RecordingEventDispatcher(new Application());
    await dispatcher.dispatch(new PostCreated("p1"));

    expect(() => dispatcher.assertNotDispatched(PostDeleted)).not.toThrow();
    expect(() => dispatcher.assertNotDispatched(PostCreated)).toThrow();
  });

  it("assertNothingDispatched and reset()", async () => {
    const dispatcher = new RecordingEventDispatcher(new Application());
    expect(() => dispatcher.assertNothingDispatched()).not.toThrow();

    await dispatcher.dispatch(new PostCreated("p1"));
    expect(() => dispatcher.assertNothingDispatched()).toThrow();

    dispatcher.reset();
    expect(() => dispatcher.assertNothingDispatched()).not.toThrow();
  });

  describe("assertDispatchedTimes", () => {
    it("passes on the exact count and throws otherwise", async () => {
      const dispatcher = new RecordingEventDispatcher(new Application());
      await dispatcher.dispatch(new PostCreated("p1"));
      await dispatcher.dispatch(new PostCreated("p2"));

      expect(() => dispatcher.assertDispatchedTimes(PostCreated, 2)).not.toThrow();
      expect(() => dispatcher.assertDispatchedTimes(PostCreated, 1)).toThrow(
        /dispatched 1 time\(s\), but it was dispatched 2 time\(s\)/,
      );
    });

    it("counts zero for an event never dispatched", () => {
      const dispatcher = new RecordingEventDispatcher(new Application());
      expect(() => dispatcher.assertDispatchedTimes(PostDeleted, 0)).not.toThrow();
    });

    it("honours a filter", async () => {
      const dispatcher = new RecordingEventDispatcher(new Application());
      await dispatcher.dispatch(new PostCreated("p1"));
      await dispatcher.dispatch(new PostCreated("p2"));

      expect(() =>
        dispatcher.assertDispatchedTimes(PostCreated, 1, (e) => e.postId === "p1"),
      ).not.toThrow();
    });
  });

  it("respects Event.suppress() — a suppressed event is neither recorded nor run", async () => {
    const dispatcher = new RecordingEventDispatcher(new Application());

    await Event.suppress(async () => {
      await dispatcher.dispatch(new PostCreated("p1"));
    });

    expect(dispatcher.dispatched(PostCreated)).toHaveLength(0);
  });

  describe("assertDispatchedAfterCommit", () => {
    afterEach(() => clearAfterCommitResolver());

    class OrderPlaced extends AbstractEvent {
      static shouldDispatchAfterCommit = true;
    }

    it("passes for a marked event dispatched inside a transaction", async () => {
      setAfterCommitResolver({ run: async (cb) => void cb(), active: () => true });
      const dispatcher = new RecordingEventDispatcher(new Application());

      await dispatcher.dispatch(new OrderPlaced());
      expect(() => dispatcher.assertDispatchedAfterCommit(OrderPlaced)).not.toThrow();
    });

    it("throws for a marked event dispatched with no transaction open (immediate)", async () => {
      const dispatcher = new RecordingEventDispatcher(new Application());

      await dispatcher.dispatch(new OrderPlaced());
      expect(() => dispatcher.assertDispatchedAfterCommit(OrderPlaced)).toThrow(/immediate/);
    });

    it("throws when the event was never dispatched", () => {
      const dispatcher = new RecordingEventDispatcher(new Application());
      expect(() => dispatcher.assertDispatchedAfterCommit(OrderPlaced)).toThrow(/not dispatched/);
    });

    it("records dispatchAfterCommit() as after-commit inside a transaction", async () => {
      setAfterCommitResolver({ run: async (cb) => void cb(), active: () => true });
      const dispatcher = new RecordingEventDispatcher(new Application());

      await dispatcher.dispatchAfterCommit(new PostCreated("p1"));
      expect(() => dispatcher.assertDispatchedAfterCommit(PostCreated)).not.toThrow();
    });
  });
});

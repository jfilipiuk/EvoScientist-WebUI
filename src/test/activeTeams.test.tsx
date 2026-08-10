// @vitest-environment jsdom
//
// Scenario: user summons an expert team, then submits a message. The outgoing
// stream.submit config must carry `configurable.active_teams: [<team-name>]`
// so the backend's ActiveTeamMiddleware picks it up on the run. Dismissing
// the team drops the key entirely on subsequent submits.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";

// Lets a test drive the `threadId` query-state (nuqs) that useChat reads. The
// holder is created via vi.hoisted so both the mock factory and the test body
// reference the same object despite vi.mock hoisting.
const { threadIdControl } = vi.hoisted(() => ({
  threadIdControl: { set: null as null | ((v: string | null) => void) },
}));
import { toast } from "sonner";
import {
  MockStreamStore,
  clearMockStreamStore,
  installMockStreamStore,
  useMockStreamHook,
} from "@/test/mockUseStream";
import {
  MockClient,
  clearMockClient,
  getActiveMockClient,
  installMockClient,
} from "@/test/mockClient";

vi.mock("@langchain/langgraph-sdk/react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useStream: useMockStreamHook };
});

vi.mock("@/providers/ClientProvider", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ClientProvider: ({ children }: { children: React.ReactNode }) => children,
    useClient: () => getActiveMockClient(),
  };
});

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    // Key-aware so the "threadId" state is drivable from tests via
    // threadIdControl.set(...). Other keys still get their own local state.
    useQueryState: (key: string) => {
      const [value, setValue] = react.useState<string | null>(null);
      if (key === "threadId") threadIdControl.set = setValue;
      return [value, setValue];
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { renderChat } from "@/test/renderChat";
import {
  fixtureAssistant as fixtureBareAssistant,
  fixtureAssistantWithConfig as fixtureAssistant,
  fixtureAssistantWithSeededTeams,
} from "@/test/fixtures/assistants";
import type { MockThreadRecord } from "@/test/mockClient";

describe("configurable.active_teams wiring", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.mocked(toast.error).mockClear();
  });

  it("sends configurable.active_teams when a team is summoned", async () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    await act(async () => {
      await result.current.setActiveTeams(["idea-brainstorm"]);
    });

    act(() => {
      result.current.sendMessage("brainstorm please");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);
    const opts = calls[0].options as {
      config: { configurable: Record<string, unknown> };
    };
    expect(opts.config.configurable.active_teams).toEqual(["idea-brainstorm"]);
    // Assistant-level configurable is preserved alongside.
    expect(opts.config.configurable.some_seed).toBe("abc");
  });

  it("omits active_teams when no team is summoned", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    act(() => {
      result.current.sendMessage("hi");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);
    const opts = calls[0].options as {
      config: { configurable: Record<string, unknown> };
    };
    expect(opts.config.configurable.active_teams).toBeUndefined();
  });

  it("drops active_teams on next submit after Dismiss", async () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    await act(async () => {
      await result.current.setActiveTeams(["idea-brainstorm"]);
    });
    act(() => {
      result.current.sendMessage("first");
    });
    await act(async () => {
      await result.current.setActiveTeams([]);
    });
    act(() => {
      result.current.sendMessage("second");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(2);
    const first = calls[0].options as {
      config: { configurable: Record<string, unknown> };
    };
    const second = calls[1].options as {
      config: { configurable: Record<string, unknown> };
    };
    expect(first.config.configurable.active_teams).toEqual(["idea-brainstorm"]);
    expect(second.config.configurable.active_teams).toBeUndefined();
  });
});

// Guards the `delete configurable.active_teams` line in buildRunConfig: when the
// assistant's own base config carries an `active_teams` selection, it must not
// ride along on runs where the user has no per-thread selection. Without the
// delete, a dismissed selection would silently fall back to the assistant-level
// list instead of clearing.
describe("configurable.active_teams inherited from assistant config", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.mocked(toast.error).mockClear();
  });

  it("strips inherited active_teams when no team is summoned", () => {
    const { result } = renderChat({
      activeAssistant: fixtureAssistantWithSeededTeams,
    });

    act(() => {
      result.current.sendMessage("hi");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);
    const opts = calls[0].options as {
      config: { configurable: Record<string, unknown> };
    };
    // The assistant-level ["assistant-default"] must be dropped, not inherited.
    expect(opts.config.configurable.active_teams).toBeUndefined();
    // Other assistant-level config is still preserved.
    expect(opts.config.configurable.some_seed).toBe("abc");
  });

  it("does not fall back to inherited active_teams after Dismiss", async () => {
    const { result } = renderChat({
      activeAssistant: fixtureAssistantWithSeededTeams,
    });

    await act(async () => {
      await result.current.setActiveTeams(["idea-brainstorm"]);
    });
    act(() => {
      result.current.sendMessage("summoned");
    });
    await act(async () => {
      await result.current.setActiveTeams([]);
    });
    act(() => {
      result.current.sendMessage("dismissed");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(2);
    const summoned = calls[0].options as {
      config: { configurable: Record<string, unknown> };
    };
    const dismissed = calls[1].options as {
      config: { configurable: Record<string, unknown> };
    };
    // The summon wins over the assistant-level default (no merge, no duplicate).
    expect(summoned.config.configurable.active_teams).toEqual([
      "idea-brainstorm",
    ]);
    // After Dismiss the run carries no teams — the inherited default stays gone.
    expect(dismissed.config.configurable.active_teams).toBeUndefined();
  });
});

// Guards the `setActiveTeamsState([])` clear at the top of the thread-switch
// effect: on switching threads the previous thread's teams must not linger in
// local state during the metadata round-trip, or a message sent in that window
// would carry the old thread's active_teams.
describe("active_teams cleared on thread switch", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.mocked(toast.error).mockClear();
  });

  it("clears the previous thread's teams before the new fetch resolves", async () => {
    const client = getActiveMockClient();
    let resolveB!: (record: MockThreadRecord) => void;
    const bPending = new Promise<MockThreadRecord>((res) => {
      resolveB = res;
    });
    // Thread A resolves immediately with a persisted team; thread B's metadata
    // fetch is held pending so we can observe the transient switch window.
    client.threads.get.mockImplementation(async (id: string) => {
      if (id === "thread-a") return { metadata: { active_teams: ["team-a"] } };
      if (id === "thread-b") return bPending;
      return {};
    });

    const { result } = renderChat({ activeAssistant: fixtureBareAssistant });

    // Open thread A: seeded from its persisted metadata.
    await act(async () => {
      threadIdControl.set?.("thread-a");
    });
    expect(result.current.activeTeams).toEqual(["team-a"]);

    // Switch to thread B while its fetch is still in flight: activeTeams must
    // already be empty, not lingering on thread A's ["team-a"].
    await act(async () => {
      threadIdControl.set?.("thread-b");
    });
    expect(result.current.activeTeams).toEqual([]);

    // Once B's metadata resolves, its persisted list seeds in.
    await act(async () => {
      resolveB({ metadata: { active_teams: ["team-b"] } });
      await bPending;
    });
    expect(result.current.activeTeams).toEqual(["team-b"]);
  });
});

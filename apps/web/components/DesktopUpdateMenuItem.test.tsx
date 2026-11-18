// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopUpdateStatus,
  InboxZeroDesktopApi,
} from "@/utils/desktop-app";
import { DesktopUpdateMenuItem } from "./DesktopUpdateMenuItem";
import { DesktopUpdateToast } from "@/app/(app)/DesktopUpdateToast";
import { toast } from "sonner";

vi.mock("@/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: React.PropsWithChildren) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: React.PropsWithChildren) => (
    <li>{children}</li>
  ),
  SidebarMenuButton: ({
    children,
    onClick,
  }: React.PropsWithChildren<{ onClick: () => void }>) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
// The menu item is off by default (the desktop app is not shipped). These tests
// exercise it as if it were on; the last one checks the real default.
const { mockPromos } = vi.hoisted(() => ({ mockPromos: { show: true } }));
vi.mock("@/utils/upstream-promos", () => ({
  get SHOW_UPSTREAM_PROMOS() {
    return mockPromos.show;
  },
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
}));

afterEach(() => {
  mockPromos.show = true;
  cleanup();
  window.inboxZeroDesktop = undefined;
  vi.clearAllMocks();
});

describe("desktop update footer", () => {
  it.each([
    undefined,
    { startAuth: async () => {} },
    { onUpdateStatus: vi.fn() },
    { installUpdate: vi.fn() },
  ])("hides without both bridge methods (%s)", (bridge) => {
    window.inboxZeroDesktop = bridge as InboxZeroDesktopApi | undefined;
    render(<DesktopUpdateMenuItem />);
    expect(
      screen.queryByRole("button", { name: "Restart to update" }),
    ).toBeNull();
  });

  it("shares status with the toast, shows only ready, and installs on click", () => {
    let push: (status: DesktopUpdateStatus) => void = () => {};
    const unsubscribe = vi.fn();
    const installUpdate = vi.fn();
    const onUpdateStatus = vi.fn((listener: typeof push) => {
      push = listener;
      listener(null);
      return unsubscribe;
    });
    window.inboxZeroDesktop = {
      startAuth: async () => {},
      onUpdateStatus,
      installUpdate,
    };
    const view = render(
      <>
        <DesktopUpdateMenuItem />
        <DesktopUpdateToast />
      </>,
    );
    expect(
      screen.queryByRole("button", { name: "Restart to update" }),
    ).toBeNull();
    act(() => push({ state: "downloading", version: "1.2", percent: 42 }));
    expect(
      screen.queryByRole("button", { name: "Restart to update" }),
    ).toBeNull();
    expect(toast).toHaveBeenCalled();
    vi.mocked(toast).mockClear();
    act(() => push({ state: "ready", version: "1.2" }));
    expect(toast).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalledWith("desktop-app-update");
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdateStatus).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows ready returned to a late subscriber", () => {
    window.inboxZeroDesktop = {
      startAuth: async () => {},
      onUpdateStatus: (listener) => {
        listener({ state: "ready", version: "1.2" });
        return () => {};
      },
      installUpdate: vi.fn(),
    };
    render(<DesktopUpdateMenuItem />);
    expect(
      screen.getByRole("button", { name: "Restart to update" }),
    ).toBeDefined();
  });

  it("renders nothing while the upstream promos switch is off, even for a ready update", () => {
    mockPromos.show = false;
    window.inboxZeroDesktop = {
      startAuth: async () => {},
      onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => {
        listener({ state: "ready", version: "1.2" });
        return () => {};
      },
      installUpdate: vi.fn(),
    };

    render(<DesktopUpdateMenuItem />);

    expect(
      screen.queryByRole("button", { name: "Restart to update" }),
    ).toBeNull();

    // The same bridge with the switch on does show it.
    cleanup();
    mockPromos.show = true;
    render(<DesktopUpdateMenuItem />);

    expect(
      screen.getByRole("button", { name: "Restart to update" }),
    ).toBeTruthy();
  });
});

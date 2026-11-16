/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { useSWRMock } = vi.hoisted(() => ({ useSWRMock: vi.fn() }));
vi.mock("swr", () => ({ default: useSWRMock }));
vi.mock("@/app/(app)/[emailAccountId]/mail/TaskpilotConvertModal", () => ({
  TaskpilotConvertModal: () => null,
}));

import { TaskpilotConvertButton } from "./TaskpilotConvertButton";

(globalThis as { React?: typeof React }).React = React;

afterEach(cleanup);

describe("TaskpilotConvertButton", () => {
  it("is hidden for a user without their own TaskPilot settings", () => {
    useSWRMock.mockReturnValue({ data: { configured: false } });

    render(<TaskpilotConvertButton emailAccountId="a1" messageId="m1" />);

    expect(screen.queryByLabelText("Convert to TaskPilot task")).toBeNull();
  });

  it("shows for a user whose own TaskPilot settings are configured", () => {
    useSWRMock.mockReturnValue({ data: { configured: true } });

    render(<TaskpilotConvertButton emailAccountId="a1" messageId="m1" />);

    expect(screen.getByLabelText("Convert to TaskPilot task")).toBeTruthy();
    // The signed-in user's status, never the mailbox owner's.
    expect(useSWRMock).toHaveBeenCalledWith("/api/user/me/taskpilot-status");
  });
});

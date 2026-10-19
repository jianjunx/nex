// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocalServicesMenu } from "./LocalServicesMenu";
import { useProjectStore } from "@/stores/project.store";
import { serviceAction, serviceList, serviceLogs, type LocalService } from "@/bridge/tauri";

vi.mock("@/bridge/tauri", () => ({
  serviceList: vi.fn(), serviceAction: vi.fn(), serviceLogs: vi.fn(), openExternal: vi.fn(),
}));
const service: LocalService = {
  id: "s1", name: "Web", command: "npm run dev", cwd: "/repo/web", projectPath: "/repo",
  conversationId: "c1", status: "running", pid: 1234, port: 5173, listening: true, exitCode: null, error: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(serviceList).mockResolvedValue([service]);
  vi.mocked(serviceLogs).mockResolvedValue("Server ready");
  vi.mocked(serviceAction).mockResolvedValue(undefined);
  useProjectStore.setState({ activeProjectId: "p1", projects: [
    { id: "p1", path: "/repo", name: "repo", created_at: 0, last_opened: 0 },
    { id: "p2", path: "/other", name: "other", created_at: 0, last_opened: 0 },
  ] });
});
afterEach(cleanup);
async function open() {
  render(<LocalServicesMenu />);
  fireEvent.click(screen.getByRole("button", { name: "本地服务" }));
  await screen.findByText("Web");
}
describe("LocalServicesMenu", () => {
  it("shows running services and manages them without prompting the agent", async () => {
    await open();
    expect(screen.getByRole("img", { name: "运行中" })).toBeTruthy();
    expect(screen.getByText("5173")).toBeTruthy();
    expect(screen.queryByText("运行中")).toBeNull();
    expect(screen.queryByText(service.command)).toBeNull();
    expect(screen.queryByText(service.cwd)).toBeNull();
    expect(screen.queryByText(/来源：|端口可连接|端口未就绪/)).toBeNull();
    for (const name of ["重启", "停止", "日志"]) {
      const button = screen.getByRole("button", { name });
      expect(button.textContent).toBe("");
      expect(button.title).toBe(name);
    }
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(serviceAction).toHaveBeenCalledWith("/repo", "s1", "stop"));
  });
  it("restarts using the captured service id and shows recent logs", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "重启" }));
    await waitFor(() => expect(serviceAction).toHaveBeenCalledWith("/repo", "s1", "restart"));
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByText("Server ready")).toBeTruthy();
    expect(serviceLogs).toHaveBeenCalledWith("/repo", "s1");
  });
  it("keeps failed services visible for retry and displays operation failures", async () => {
    vi.mocked(serviceList).mockResolvedValue([{ ...service, status: "failed", pid: null, exitCode: 1, error: "Process exited with code 1" }]);
    vi.mocked(serviceAction).mockRejectedValue(new Error("port busy"));
    await open();
    const status = screen.getByRole("img", { name: "启动失败" });
    expect(status.classList.contains("bg-[var(--error)]")).toBe(true);
    expect(status.title).toBe("Process exited with code 1");
    expect(screen.queryByText("退出码：1")).toBeNull();
    expect(screen.getByRole("button", { name: "启动" }).querySelector(".lucide-play")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "port busy");
  });
  it("does not expose the previous project's controls while the next project loads", async () => {
    await open();
    vi.mocked(serviceList).mockImplementation(() => new Promise(() => {}));
    useProjectStore.setState({ activeProjectId: "p2" });
    await waitFor(() => expect(screen.queryByText("Web")).toBeNull());
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });
  it("shows an empty state explaining how services appear", async () => {
    vi.mocked(serviceList).mockResolvedValue([]);
    render(<LocalServicesMenu />);
    fireEvent.click(screen.getByRole("button", { name: "本地服务" }));
    expect(await screen.findByText(/暂无托管服务/)).toBeTruthy();
  });
});

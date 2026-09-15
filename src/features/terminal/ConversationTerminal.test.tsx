// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUiStore } from "@/stores/ui.store";
import { useProjectStore } from "@/stores/project.store";
import { ConversationTerminal } from "./ConversationTerminal";
vi.mock("./TerminalPanel",()=>({TerminalPanel:()=> <div>terminal content</div>}));
afterEach(cleanup);
it("shows independently without opening the right panel",()=>{
  useProjectStore.setState({activeProjectId:"p"});
  useUiStore.setState({sidePanelVisible:false,terminalVisible:false,terminalVisibleByProject:{}});
  useUiStore.getState().toggleTerminal();
  render(<ConversationTerminal/>);
  expect(screen.getByRole("region",{name:"对话终端"})).toBeTruthy();
  expect(useUiStore.getState().sidePanelVisible).toBe(false);
});

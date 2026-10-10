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
  useUiStore.setState({sidePanelVisible:false,terminalVisible:false,terminalVisibleByProject:{},terminalStartupSettled:true});
  useUiStore.getState().toggleTerminal();
  render(<ConversationTerminal/>);
  expect(screen.getByRole("region",{name:"对话终端"})).toBeTruthy();
  expect(useUiStore.getState().sidePanelVisible).toBe(false);
});
it("does not mount the tray before startup settled (no flash of the persisted visibility)",()=>{
  useProjectStore.setState({activeProjectId:"p"});
  useUiStore.setState({sidePanelVisible:true,terminalVisible:true,terminalVisibleByProject:{p:true},terminalStartupSettled:false});
  render(<ConversationTerminal/>);
  // The persisted flag says visible, but the tray must stay unmounted until
  // App's startup restore ran its final sync — otherwise the startup chain
  // flipping visibility back paints a tray that instantly disappears.
  expect(screen.queryByRole("region",{name:"对话终端"})).toBeNull();
});

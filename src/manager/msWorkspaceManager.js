const { Shell, Meta, St, GLib } = imports.gi;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Signals = imports.signals;
const { MsWorkspace } = Me.imports.src.materialShell.msWorkspace.msWorkspace;
const {
    MsWorkspaceContainer,
} = Me.imports.src.materialShell.msWorkspaceContainer;
const { WorkspaceList } = Me.imports.src.widget.workspaceList;
const { MsWindow } = Me.imports.src.materialShell.msWorkspace.msWindow;
const { MsManager } = Me.imports.src.manager.msManager;
const { AddLogToFunctions } = Me.imports.src.utils.debug;

/* exported MsWorkspaceManager */
var MsWorkspaceManager = class MsWorkspaceManager extends MsManager {
    constructor() {
        super();
        AddLogToFunctions(this);
        this.workspaceManager = global.workspace_manager;
        this.windowTracker = Shell.WindowTracker.get_default();
        this.msWorkspaceList = [];
        this.categoryList = Me.stateManager.getState('categoryList') || [];
        this.noUImode = false;
        this.metaWindowFocused = null;

        this.msWorkspaceContainer = new MsWorkspaceContainer(this);
        Main.uiGroup.insert_child_above(
            this.msWorkspaceContainer,
            global.window_group
        );

        this.workspaceList = new WorkspaceList(this);
        Main.panel._leftBox.add_child(this.workspaceList);
        this.observe(Me.msWindowManager, 'ms-window-focused', (_, msWindow) => {
            if (msWindow && !msWindow.isDialog && msWindow.msWorkspace) {
                msWindow.msWorkspace.focusTileable(msWindow);
            }
        });

        this.observe(global.display, 'in-fullscreen-changed', () => {
            Main.layoutManager.monitors.forEach((monitor) => {
                let msWorkspace;
                if (Main.layoutManager.primaryIndex === monitor.index) {
                    msWorkspace = this.getActiveMsWorkspace();
                } else {
                    msWorkspace = this.getMsWorkspacesOfMonitorIndex(
                        monitor.index
                    )[0];
                }
                if (msWorkspace) {
                    msWorkspace.updateUI();
                }
            });
        });

        this.observe(
            global.display,
            'window-entered-monitor',
            (display, monitorIndex, window) => {
                //Ignore unHandle window and window on primary screens
                this.windowEnteredMonitor(window, monitorIndex);
            }
        );

        this.observe(
            this.workspaceManager,
            'workspace-added',
            (_, workspaceIndex) => {
                if (this.restoringState) return;
                this.setupNewWorkspace(
                    this.workspaceManager.get_workspace_by_index(workspaceIndex)
                );
            }
        );

        this.observe(
            this.workspaceManager,
            'workspace-removed',
            (_, workspaceIndex) => {
                log('workspace-removed', workspaceIndex);
                this.removeMsWorkspaceAtIndex(workspaceIndex);
            }
        );

        this.observe(Main.layoutManager, 'monitors-changed', () => {
            //Manage multiple monitors
        });
    }

    init() {
        this.setupInitialState();
        this.refreshVisiblePrimaryMsWorkspace();
    }

    destroy() {
        super.destroy();
        for (var i = 0; i < this.workspaceManager.n_workspaces; i++) {
            let workspace = this.workspaceManager.get_workspace_by_index(i);
            delete workspace._keepAliveId;
        }
        for (let msWorkspace of this.msWorkspaceList) {
            msWorkspace.destroy();
        }
        this.workspaceList.destroy();
        this.msWorkspaceContainer.destroy();
    }

    setupInitialState() {
        let previousState = Me.stateManager.getState('workspaces-state');
        this.restoringState = true;
        if (previousState && previousState.primaryWorkspaceList) {
            log(
                `State contain ${previousState.primaryWorkspaceList.length} to restore and we currently have ${this.workspaceManager.n_workspaces} workspaces`
            );
            if (
                this.workspaceManager.n_workspaces <
                previousState.primaryWorkspaceList.length
            ) {
                for (
                    let i = 0;
                    i <=
                    previousState.primaryWorkspaceList.length -
                        this.workspaceManager.n_workspaces;
                    i++
                ) {
                    log(
                        'Creating new workspace',
                        this.workspaceManager.n_workspaces
                    );
                    this.workspaceManager.append_new_workspace(
                        false,
                        global.get_current_time()
                    );
                    log('after ', this.workspaceManager.n_workspaces);
                }
            }
        }
        for (let monitor of Main.layoutManager.monitors) {
            if (Main.layoutManager.primaryIndex === monitor.index) {
                for (let i = 0; i < this.workspaceManager.n_workspaces; i++) {
                    const initialState =
                        previousState &&
                        previousState.primaryWorkspaceList &&
                        previousState.primaryWorkspaceList[i];
                    this.setupNewWorkspace(
                        this.workspaceManager.get_workspace_by_index(i),
                        initialState
                    );
                }
            } else {
                this.createNewMsWorkspace(monitor);
            }
        }
        delete this.restoringState;
    }

    get primaryMsWorkspaces() {
        if (!this.msWorkspaceList) return [];
        return this.msWorkspaceList.filter((msWorkspace) => {
            return (
                msWorkspace.monitor.index === Main.layoutManager.primaryIndex
            );
        });
    }

    get msWorkspacesWithCategory() {
        return this.primaryMsWorkspaces.filter((msWorkspace) => {
            return msWorkspace.category != null;
        });
    }

    get dynamicMsWorkspaces() {
        return this.primaryMsWorkspaces.filter((msWorkspace) => {
            return !msWorkspace.category;
        });
    }

    setupNewWorkspace(workspace, initialState) {
        log('setupNewWorkspace', workspace.index());
        workspace._keepAliveId = true;
        this.createNewMsWorkspace(
            Main.layoutManager.primaryMonitor,
            initialState
        );
        this.observe(workspace, 'window-added', (workspace, window) => {
            this.metaWindowEnteredWorkspace(window, workspace);
        });
    }

    createNewMsWorkspace(monitor, initialState) {
        log('createNewMsWorkspace');
        let msWorkspace = new MsWorkspace(this, monitor, initialState);
        msWorkspace.connect('tileableList-changed', (_) => {
            this.stateChanged();
        });
        msWorkspace.connect('tiling-layout-changed', (_) => {
            this.saveCurrentState();
        });
        this.msWorkspaceList.push(msWorkspace);
        this.stateChanged();
        this.emit('dynamic-super-workspaces-changed');
    }

    removeMsWorkspaceAtIndex(index) {
        const msWorkspaceToDelete = this.primaryMsWorkspaces[index];
        if (msWorkspaceToDelete) {
            const globalIndex = this.msWorkspaceList.indexOf();
            this.msWorkspaceList.splice(globalIndex, 1);
            msWorkspaceToDelete.destroy();
            this.stateChanged();
            this.emit('dynamic-super-workspaces-changed');
        }
    }

    stateChanged() {
        if (this.restoringState && this.stateChangedTriggered) return;
        this.stateChangedTriggered = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            log('IDLE_ADD');
            this.refreshWorkspaceWindows();
            this.refreshVisiblePrimaryMsWorkspace();
            this.checkWorkspaceKeepAlive();
            this.saveCurrentState();
            this.stateChangedTriggered = false;
        });
    }

    checkWorkspaceKeepAlive() {
        log('checkWorkspaceKeepAlive');
        this.primaryMsWorkspaces.forEach((msWorkspace) => {
            const workspace = this.getWorkspaceOfMsWorkspace(msWorkspace);
            if (workspace) {
                workspace._keepAliveId = msWorkspace.msWindowList.length > 0;
                log('workspace keep alive', workspace._keepAliveId);
            }
        });
        if (this.workspaceManager.get_active_workspace()._keepAliveId) {
            Main.wm._workspaceTracker._checkWorkspaces();
        }
    }

    setWorkspaceBefore(categoryKeyToMove, categoryKeyRelative) {
        let categoryKeyToMoveIndex = this.categoryKeyOrderedList.indexOf(
            categoryKeyToMove
        );
        this.categoryKeyOrderedList.splice(categoryKeyToMoveIndex, 1);

        let categoryKeyRelativeIndex = this.categoryKeyOrderedList.indexOf(
            categoryKeyRelative
        );
        this.categoryKeyOrderedList.splice(
            categoryKeyRelativeIndex,
            0,
            categoryKeyToMove
        );
        this.stateChanged();
    }

    setWorkspaceAfter(categoryKeyToMove, categoryKeyRelative) {
        let categoryKeyToMoveIndex = this.categoryKeyOrderedList.indexOf(
            categoryKeyToMove
        );
        this.categoryKeyOrderedList.splice(categoryKeyToMoveIndex, 1);

        let categoryKeyRelativeIndex = this.categoryKeyOrderedList.indexOf(
            categoryKeyRelative
        );
        this.categoryKeyOrderedList.splice(
            categoryKeyRelativeIndex + 1,
            0,
            categoryKeyToMove
        );
        this.stateChanged();
    }

    saveCurrentState() {
        const workspacesState = {
            externalWorkspaces: [],
        };
        for (let monitor of Main.layoutManager.monitors) {
            if (Main.layoutManager.primaryIndex === monitor.index) {
                workspacesState.primaryWorkspaceList = this.primaryMsWorkspaces
                    .filter((msWorkspace) => {
                        return msWorkspace.tileableList.length;
                    })
                    .map((msWorkspace) => {
                        return msWorkspace.getState();
                    });
            } else {
                workspacesState.externalWorkspaces.push(
                    this.getMsWorkspacesOfMonitorIndex(monitor.index).getState()
                );
            }
        }
        Me.stateManager.setState('workspaces-state', workspacesState);
    }

    refreshWorkspaceWindows() {
        this.primaryMsWorkspaces.forEach((msWorkspace) => {
            let workspace = this.getWorkspaceOfMsWorkspace(msWorkspace);
            for (let msWindow of msWorkspace.msWindowList) {
                if (msWindow.metaWindow) {
                    msWindow.metaWindow.change_workspace(workspace);
                }
            }
        });
    }

    refreshVisiblePrimaryMsWorkspace() {
        let activeMsWorkspace = this.getActiveMsWorkspace();
        this.msWorkspaceList.forEach((msWorkspace) => {
            if (
                msWorkspace.monitor !== Main.layoutManager.primaryMonitor ||
                msWorkspace === activeMsWorkspace
            ) {
                activeMsWorkspace.uiVisible = true;
                activeMsWorkspace.updateUI();
            } else {
                msWorkspace.uiVisible = false;
                msWorkspace.updateUI();
            }
        });
    }

    getActiveMsWorkspace() {
        let activeWorkspaceIndex = this.workspaceManager.get_active_workspace_index();
        return this.primaryMsWorkspaces[activeWorkspaceIndex];
    }

    getMsWorkspaceByCategoryKey(categoryKey) {
        return this.msWorkspaceList.find((msWorkspace) => {
            return msWorkspace.categoryKey === categoryKey;
        });
    }

    getWorkspaceOfMsWorkspace(msWorkspace) {
        return this.workspaceManager.get_workspace_by_index(
            this.primaryMsWorkspaces.indexOf(msWorkspace)
        );
    }

    getMsWorkspacesOfMonitorIndex(monitorIndex) {
        return this.msWorkspaceList.filter((msWorkspace) => {
            return msWorkspace.monitor.index === monitorIndex;
        });
    }

    getMsWorkspaceOfMetaWindow(metaWindow) {
        const windowMonitorIndex = metaWindow.get_monitor();
        if (windowMonitorIndex !== Main.layoutManager.primaryIndex) {
            return this.getMsWorkspacesOfMonitorIndex(windowMonitorIndex)[0];
        } else {
            return this.primaryMsWorkspaces[metaWindow.get_workspace().index()];
        }
    }

    getMsWorkspaceOfMsWindow(msWindow) {
        return this.msWorkspaceList.find((msWorkspace) => {
            return msWorkspace.msWindowList.includes(msWindow);
        });
    }

    addWindowToAppropriateMsWorkspace(msWindow) {
        const windowMonitorIndex = msWindow.metaWindow.get_monitor();
        const currentWindowWorkspace = msWindow.metaWindow.get_workspace();
        let msWorkspace;

        if (windowMonitorIndex !== Main.layoutManager.primaryIndex) {
            msWorkspace = this.getMsWorkspacesOfMonitorIndex(
                windowMonitorIndex
            )[0];
        } else {
            msWorkspace = this.primaryMsWorkspaces[
                currentWindowWorkspace.index()
            ];
        }
        this.setWindowToMsWorkspace(msWindow, msWorkspace);
        this.stateChanged();
    }

    metaWindowEnteredWorkspace(metaWindow, workspace) {
        if (
            !metaWindow.handledByMaterialShell ||
            metaWindow.on_all_workspaces ||
            !metaWindow.get_compositor_private()
        ) {
            return;
        }
        const msWorkspace = this.primaryMsWorkspaces[workspace.index()];
        this.setWindowToMsWorkspace(metaWindow.msWindow, msWorkspace);
    }

    windowEnteredMonitor(metaWindow, monitorIndex) {
        //Ignore unHandle metaWindow and metaWindow on secondary screens
        if (
            !metaWindow.handledByMaterialShell ||
            monitorIndex === Main.layoutManager.primaryIndex
        ) {
            return;
        }
        const msWorkspace = this.getMsWorkspacesOfMonitorIndex(monitorIndex)[0];

        if (!msWorkspace) {
            return;
        }

        this.setWindowToMsWorkspace(metaWindow, msWorkspace);
    }

    setWindowToMsWorkspace(msWindow, newMsWorkspace) {
        if (msWindow.metaWindow) {
            if (
                newMsWorkspace.monitor.index !=
                msWindow.metaWindow.get_monitor()
            ) {
                return msWindow.metaWindow.move_to_monitor(
                    newMsWorkspace.monitor
                );
            }
            const newWorkspace = this.getWorkspaceOfMsWorkspace(newMsWorkspace);
            if (msWindow.metaWindow.get_workspace() != newWorkspace) {
                return msWindow.metaWindow.change_workspace(newWorkspace);
            }
        }
        let oldMsWorkspace = msWindow.msWorkspace;

        if (oldMsWorkspace) {
            if (oldMsWorkspace === newMsWorkspace) {
                return;
            } else {
                oldMsWorkspace.removeMsWindow(msWindow);
            }
        }

        newMsWorkspace.addMsWindow(msWindow);
        this.stateChanged();
    }

    _handleWindow(metaWindow) {
        let meta = Meta.WindowType;
        let types = [meta.NORMAL, meta.DIALOG, meta.MODAL_DIALOG, meta.UTILITY];
        return types.includes(metaWindow.window_type);
    }
};
import { Menu, MenuItem, Plugin, Keymap, TFolder, TAbstractFile, Platform } from 'obsidian'
import type { FileTreeItem, TreeItem, FileExplorerView, InfinityScroll, InfinityScrollRootEl, FolderTreeItem } from 'obsidian-typings'
import { around } from 'monkey-around'
import Sortable, { type SortableEvent } from 'sortablejs'
import { ResetOrderModal } from '@/reset-order-modal'
import { OrderManager } from '@/order-manager'
import type { PluginSettings, SortablePrototype } from '@/types.d'
import { DEFAULT_SETTINGS, MANUAL_SORTING_MODE_ID } from '@/constants'

export default class ManualSortingPlugin extends Plugin {
	private _orderManager!: OrderManager
	private _explorerUnpatchFunctions: ReturnType<typeof around>[] = []
	private _unpatchMenu: ReturnType<typeof around> | null = null
	private _itemBeingCreatedManually = false
	private _recentExplorerAction = ''
	private _sortableInstances: Sortable[] = []
	public settings!: PluginSettings

	async onload() {
		if (process.env.DEV) console.log('Loading Manual Sorting in dev mode')
		await this.loadSettings()
		this.app.workspace.onLayoutReady(() => {
			void this.initialize()
		})
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PluginSettings>)
		console.log('Settings loaded:', this.settings, 'Custom file order:', this.settings.customFileOrder)
	}

	async saveSettings() {
		await this.saveData(this.settings)
		console.log('Settings saved:', this.settings, 'Custom file order:', this.settings.customFileOrder)
	}

	onunload() {
		this._explorerUnpatchFunctions.forEach(unpatch => unpatch())
		this._explorerUnpatchFunctions = []
		if (this.isManualSortingEnabled()) void this.reloadExplorerPlugin()
		if (this._unpatchMenu) {
			this._unpatchMenu()
			this._unpatchMenu = null
		}
	}

	getFileExplorerView = () => {
		return this.app.workspace.getLeavesOfType('file-explorer')[0].view as FileExplorerView
	}

	isManualSortingEnabled = () => {
		return this.settings.selectedSortOrder === MANUAL_SORTING_MODE_ID
	}

	async initialize() {
		const prevManualSortingEnabledStatus = this.isManualSortingEnabled()
		this.patchSortable()
		this.patchSortOrderMenu()

		await this.waitForExplorer()
		const fileExplorerView = this.getFileExplorerView()
		// fix for Obsidian not saving the last selected sorting mode
		if (!prevManualSortingEnabledStatus) {
			fileExplorerView.setSortOrder(this.settings.selectedSortOrder)
		}
		this.patchFileExplorer(fileExplorerView)

		this._orderManager = new OrderManager(this)
		this._orderManager.updateOrder()

		if (this.isManualSortingEnabled()) void this.reloadExplorerPlugin()

		this.registerEvent(this.app.vault.on('create', (treeItem) => {
			if (this.isManualSortingEnabled()) {
				console.log('Manually created item:', treeItem)
				this._itemBeingCreatedManually = true
			}
		}))
	}

	toogleDragging() {
		this._sortableInstances.forEach((sortableInstance) => {
			sortableInstance.option('disabled', !this.settings.draggingEnabled)
		})
	}

	patchSortable() {
		around((Sortable.prototype as SortablePrototype), {
			_onDragOver: original => function (evt: DragEvent) {
				if (!this.el.children.length) {
					console.warn('Container is empty, skipping onDragOver()')
					return
				}
				return original.call(this, evt)
			},
		})
	}

	async waitForExplorer() {
		return new Promise<Element>((resolve) => {
			const getExplorer = () => document.querySelector('[data-type="file-explorer"] .nav-files-container')
			const explorer = getExplorer()
			if (explorer) {
				resolve(explorer)
				return
			}

			const observer = new MutationObserver((_, obs) => {
				const explorer = getExplorer()
				if (explorer) {
					obs.disconnect()
					resolve(explorer)
				}
			})
			const workspace = document.querySelector('.workspace')
			if (workspace) observer.observe(workspace, { childList: true, subtree: true })
		})
	};

	patchFileExplorer(fileExplorerView: FileExplorerView) {
		const thisPlugin = this

		this._explorerUnpatchFunctions.push(
			around(Object.getPrototypeOf((fileExplorerView.tree.infinityScroll.rootEl as InfinityScrollRootEl).childrenEl) as HTMLElement, {
				setChildrenInPlace: original => function (this: HTMLElement, newChildren: HTMLElement[]) {
					const isInExplorer = !!this.closest('[data-type="file-explorer"]')
					const isFileTreeItem = this.classList.value.includes('tree-item') && this.classList.value.includes('nav-')

					if (!thisPlugin.isManualSortingEnabled() || (!isFileTreeItem && !isInExplorer)) {
						original.apply(this, [newChildren])
						return
					}

					const currentChildren = Array.from(this.children)
					const newChildrenSet = new Set(newChildren)

					for (const child of currentChildren) {
						const childElement = child as HTMLElement
						if (!newChildrenSet.has(childElement)) {
							const childPath = (childElement.firstElementChild as HTMLElement | null)?.getAttribute('data-path')
							if (childPath && childElement.classList.contains('tree-item')) {
								// Check if the item still exists in the vault
								const itemObject = thisPlugin.app.vault.getAbstractFileByPath(childPath)
								if (!itemObject) {
									console.warn('Item not exists in vault, removing its DOM element:', childPath)
									if (childPath) thisPlugin._orderManager.updateOrder()
									this.removeChild(child)
								} else {
									const actualParentPath = childElement.parentElement?.previousElementSibling?.getAttribute('data-path') || '/'
									const itemObjectParentPath = itemObject.parent?.path

									if ((itemObjectParentPath !== actualParentPath) && !thisPlugin.settings.draggingEnabled) {
										console.warn('Item not in the right place, removing its DOM element:', childPath)
										this.removeChild(childElement)
										// Sync file explorer DOM tree
										const fileExplorerView = thisPlugin.getFileExplorerView()
										fileExplorerView.updateShowUnsupportedFiles()
									}
								}
							}
						}
					}

					const processNewItem = (addedItem: HTMLElement) => {
						const path = (addedItem.firstChild as HTMLElement | null)?.getAttribute('data-path')
						console.log(`Adding`, addedItem, path)
						const itemContainer: HTMLElement = this
						const elementFolderPath = path?.substring(0, path.lastIndexOf('/')) || '/'
						console.log(`Item container:`, itemContainer, elementFolderPath)

						if (thisPlugin._itemBeingCreatedManually) {
							console.log('Item is being created manually')
							thisPlugin._itemBeingCreatedManually = false
							thisPlugin._orderManager.updateOrder()
						}

						if (itemContainer.classList.contains('all-children-loaded')) {
							console.warn(`All children already loaded for ${elementFolderPath}. Skipping...`)
							return
						}

						const dataPathValues = Array.from(itemContainer.children)
							.filter(item => item.firstElementChild?.hasAttribute('data-path'))
							.map(item => item.firstElementChild?.getAttribute('data-path'))
						const childrenCount = dataPathValues.length

						const expectedChildrenCount = thisPlugin.app.vault.getFolderByPath(elementFolderPath)?.children.length
						console.log(`Children count: ${childrenCount}, Expected children count: ${expectedChildrenCount}`)

						if (childrenCount === expectedChildrenCount) {
							itemContainer.classList.add('all-children-loaded')
							console.warn(`All children loaded for ${elementFolderPath}`)
							void thisPlugin._orderManager.restoreOrder(itemContainer, elementFolderPath)
						}

						const makeSortable = (container: HTMLElement) => {
							if (Sortable.get(container)) return
							console.log(`Initiating Sortable on`, container)

							const minSwapThreshold = 0.3
							const maxSwapThreshold = 2
							let origSetCollapsed: TreeItem['setCollapsed']

							function adjustSwapThreshold(item: HTMLElement) {
								const previousItem = item.previousElementSibling
								const nextItem = item.nextElementSibling

								const adjacentNavFolders = []
								if (previousItem?.classList.contains('nav-folder')) {
									adjacentNavFolders.push(previousItem)
								}
								if (nextItem?.classList.contains('nav-folder')) {
									adjacentNavFolders.push(nextItem)
								}

								if (adjacentNavFolders.length > 0) {
									sortableInstance.options.swapThreshold = minSwapThreshold

									adjacentNavFolders.forEach((navFolder) => {
										const childrenContainer = navFolder.querySelector('.tree-item-children')
										if (childrenContainer) {
											makeSortable(childrenContainer as HTMLElement)
										}
									})
								} else {
									sortableInstance.options.swapThreshold = maxSwapThreshold
								}
							}

							const sortableInstance = new Sortable(container, {
								group: 'nested',
								draggable: '.tree-item',
								chosenClass: 'manual-sorting-chosen',
								ghostClass: 'manual-sorting-ghost',

								animation: 100,
								swapThreshold: maxSwapThreshold,
								fallbackOnBody: true,
								disabled: !thisPlugin.settings.draggingEnabled,

								delay: 100,
								delayOnTouchOnly: true,

								setData: function (dataTransfer: DataTransfer, dragEl: HTMLElement) {
									dataTransfer.setData('string', 'text/plain')
									dataTransfer.setData('string', 'text/uri-list')
									dataTransfer.effectAllowed = 'all'
								},
								onChoose: (evt: SortableEvent) => {
									console.log('Sortable: onChoose')
									const dragged = evt.item
									adjustSwapThreshold(dragged)
								},
								onStart: (evt: SortableEvent) => {
									console.log('Sortable: onStart')
									const itemPath = (evt.item.firstChild as HTMLElement | null)?.getAttribute('data-path') || ''
									const itemObject = thisPlugin.app.vault.getAbstractFileByPath(itemPath)
									if (itemObject instanceof TFolder) {
										const fileTreeItem = thisPlugin.getFileExplorerView().fileItems[itemPath] as TreeItem
										fileTreeItem.setCollapsed(true, true)
										origSetCollapsed || (origSetCollapsed = fileTreeItem.setCollapsed)
										fileTreeItem.setCollapsed = () => Promise.resolve()
									}
								},
								onChange: (evt: SortableEvent) => {
									console.log('Sortable: onChange')
									const dragged = evt.item
									adjustSwapThreshold(dragged)
								},
								onEnd: (evt: SortableEvent) => {
									console.log('Sortable: onEnd')
									const draggedOverElement = document.querySelector('.is-being-dragged-over')
									const draggedItemPath = (evt.item.firstChild as HTMLElement | null)?.getAttribute('data-path') || ''
									const draggedOverElementPath = (draggedOverElement?.firstChild as HTMLElement | null)?.getAttribute('data-path')
									const destinationPath = draggedOverElementPath || evt.to.previousElementSibling?.getAttribute('data-path') || '/'

									const movedItem = thisPlugin.app.vault.getAbstractFileByPath(draggedItemPath)!
									const targetFolder = thisPlugin.app.vault.getFolderByPath(destinationPath)
									const folderPathInItemNewPath = (targetFolder?.isRoot()) ? '' : (destinationPath + '/')
									let itemNewPath = folderPathInItemNewPath + movedItem.name

									if (draggedItemPath !== itemNewPath && thisPlugin.app.vault.getAbstractFileByPath(itemNewPath)) {
										console.warn(`Name conflict detected. Path: ${itemNewPath} already exists. Resolving...`)

										const generateUniqueFilePath = (path: string): string => {
											const fullName = movedItem.name
											const lastDotIndex = fullName.lastIndexOf('.')
											const name = lastDotIndex === -1 ? fullName : fullName.slice(0, lastDotIndex)
											const extension = lastDotIndex === -1 ? '' : fullName.slice(lastDotIndex + 1)
											let revisedPath = path
											let counter = 1

											while (thisPlugin.app.vault.getAbstractFileByPath(revisedPath)) {
												const newName = `${name} ${counter}${extension ? '.' + extension : ''}`
												revisedPath = folderPathInItemNewPath + newName
												counter++
											}

											return revisedPath
										}

										itemNewPath = generateUniqueFilePath(itemNewPath)
										console.log('New item path:', itemNewPath)
									}

									const newDraggbleIndex = draggedOverElementPath ? 0 : evt.newDraggableIndex!
									thisPlugin._orderManager.moveFile(draggedItemPath, itemNewPath, newDraggbleIndex)
									void thisPlugin.app.fileManager.renameFile(movedItem, itemNewPath)

									const fileExplorerView = thisPlugin.getFileExplorerView()

									// Obsidian doesn't automatically call onRename in some cases - needed here to ensure the DOM reflects file structure changes
									if (movedItem.path === itemNewPath) {
										console.warn('Calling onRename manually for', movedItem, itemNewPath)
										fileExplorerView.onRename(movedItem, draggedItemPath)
									}

									if (movedItem instanceof TFolder) {
										const fileTreeItem = fileExplorerView.fileItems[draggedItemPath] as TreeItem
										fileTreeItem.setCollapsed = origSetCollapsed
									}

									if (!Platform.isMobile) {
										// Manually trigger the tooltip for the dragged item
										const draggedItemSelf = evt.item.querySelector('.tree-item-self')!
										const hoverEvent = new MouseEvent('mouseover', { bubbles: true, cancelable: true })
										draggedItemSelf.dispatchEvent(hoverEvent)

										// Simulate hover on the dragged item
										document.querySelector('.tree-item-self.hovered')?.classList.remove('hovered')
										draggedItemSelf.classList.add('hovered')
										draggedItemSelf.addEventListener('mouseleave', () => {
											draggedItemSelf.classList.remove('hovered')
										}, { once: true })
									}
								},
								onUnchoose: () => {
									console.log('Sortable: onUnchoose')
									if (thisPlugin.settings.draggingEnabled) {
										try {
											const dropEvent = new DragEvent('drop', {
												bubbles: true,
												cancelable: true,
												dataTransfer: new DataTransfer(),
											})

											document.dispatchEvent(dropEvent)
										} catch {
											// Ignore errors from dispatching drop event
										}
									}
								},
							})
							thisPlugin._sortableInstances.push(sortableInstance)
						}
						makeSortable(itemContainer)
					}

					for (const child of newChildren) {
						if (!this.contains(child)) {
							if (child.classList.contains('tree-item')) {
								// Fix #43: Obsidian has a top div in each .tree-item container to maintain correct scroll height
								// so we leave it in place and insert the new item below it
								const topmostTreeItem: HTMLElement | null = this.querySelector('.tree-item')
								this.insertBefore(child, topmostTreeItem)

								if (!(child.firstChild as HTMLElement | null)?.hasAttribute('data-path')) {
									new MutationObserver((mutations, obs) => {
										for (const mutation of mutations) {
											if (mutation.attributeName === 'data-path') {
												processNewItem(child)
												obs.disconnect()
												return
											}
										}
									}).observe(child.firstChild as Node, { attributes: true, attributeFilter: ['data-path'] })
								} else {
									processNewItem(child)
								}
							} else {
								this.prepend(child)
							}
						}
					}
				},
				detach: original => function (this: HTMLElement) {
					if (!thisPlugin.isManualSortingEnabled()) {
						original.apply(this)
						return
					}
					const itemNode = this
					const itemPath = (itemNode.firstChild as HTMLElement | null)?.getAttribute('data-path') ?? ''
					const itemObject = thisPlugin.app.vault.getAbstractFileByPath(itemPath)

					// Prevent detaching of existing items
					if (!itemObject) {
						original.apply(this)
						return
					}
				},
			}),
		)

		this._explorerUnpatchFunctions.push(
			around(Object.getPrototypeOf(fileExplorerView) as FileExplorerView, {
				onRename: original => function (this: FileExplorerView, file: TAbstractFile, oldPath: string) {
					original.apply(this, [file, oldPath])
					if (thisPlugin.isManualSortingEnabled()) {
						const oldDirPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/'
						if (!thisPlugin.settings.draggingEnabled && oldDirPath !== file.parent?.path) {
							thisPlugin._orderManager.moveFile(oldPath, file.path, 0)
						}
						thisPlugin._orderManager.renameItem(oldPath, file.path)
					}
				},
				setSortOrder: original => function (this: FileExplorerView, sortOrder: string) {
					// this method is called only when selecting one of the standard sorting modes
					original.call(this, sortOrder)
					const prevManualSortingEnabledStatus = thisPlugin.isManualSortingEnabled()
					thisPlugin.settings.selectedSortOrder = sortOrder

					console.log('Sort order changed to:', sortOrder)
					if (prevManualSortingEnabledStatus) {
						void thisPlugin.reloadExplorerPlugin()
					}
					void thisPlugin.saveSettings()
				},
				sort: original => function (this: FileExplorerView) {
					if (thisPlugin.isManualSortingEnabled()) {
						thisPlugin._recentExplorerAction = 'sort'
					}
					original.apply(this)
				},
				onFileMouseover: original => function (this: FileExplorerView, event: MouseEvent, targetEl: HTMLElement) {
					if (thisPlugin.isManualSortingEnabled()) {
						// Set targetEl to the dragging element if it exists to ensure the tooltip is shown correctly
						const draggingElement = document.querySelector('.manual-sorting-chosen')
						if (draggingElement) {
							targetEl = draggingElement as HTMLElement
						}
					}
					original.apply(this, [event, targetEl])
				},
			}),
		)

		this._explorerUnpatchFunctions.push(
			around(Object.getPrototypeOf(fileExplorerView.tree) as FileExplorerView['tree'], {
				setFocusedItem: original => function (this: FileExplorerView['tree'], node: FileTreeItem | FolderTreeItem, scrollIntoView?: boolean) {
					if (thisPlugin.isManualSortingEnabled()) {
						thisPlugin._recentExplorerAction = 'setFocusedItem'
					}
					original.apply(this, [node, scrollIntoView])
				},
				handleItemSelection: original => function (this: FileExplorerView['tree'], e: PointerEvent, t: TreeItem) {
					if (!thisPlugin.isManualSortingEnabled()) {
						original.apply(this, [e, t])
						return
					}

					function getItemsBetween(allPaths: string[], path1: string, path2: string) {
						const index1 = allPaths.indexOf(path1)
						const index2 = allPaths.indexOf(path2)

						if (index1 === -1 || index2 === -1) {
							return []
						}

						const startIndex = Math.min(index1, index2)
						const endIndex = Math.max(index1, index2)

						return allPaths.slice(startIndex, endIndex + 1).map(path =>
							thisPlugin.getFileExplorerView().fileItems[path],
						)
					}

					const n = this,
						i = n.selectedDoms,
						r = n.activeDom,
						o = n.view
					if (!Keymap.isModEvent(e)) {
						if (e.altKey && !e.shiftKey)
							return this.app.workspace.setActiveLeaf(o.leaf, {
								focus: !0,
							}),
							i.has(t)
								? this.deselectItem(t)
								: (this.selectItem(t),
								this.setFocusedItem(t, !1),
								this.activeDom = t),
							!0
						if (e.shiftKey) {
							this.app.workspace.setActiveLeaf(o.leaf, {
								focus: !0,
							})
							const flattenPaths = thisPlugin._orderManager.getFlattenPaths()
							const itemsBetween = getItemsBetween(flattenPaths, r.file.path, t.file.path)
							for (let a = 0, s = r ? itemsBetween : [t]; a < s.length; a++) {
								const l = s[a]
								this.selectItem(l)
							}
							return !0
						}
						if (t.selfEl.hasClass('is-being-renamed'))
							return !0
						if (t.selfEl.hasClass('is-active'))
							return this.app.workspace.setActiveLeaf(o.leaf, {
								focus: !0,
							}),
							this.setFocusedItem(t, !1),
							!0
					}
					return this.clearSelectedDoms(),
					this.setFocusedItem(null),
					this.activeDom = t,
					!1
				},
			}),
		)

		this._explorerUnpatchFunctions.push(
			around(Object.getPrototypeOf(fileExplorerView.tree.infinityScroll) as InfinityScroll, {
				scrollIntoView: original => function (this: InfinityScroll, target: { el: HTMLElement }, ...args: unknown[]) {
					const targetElement = target.el
					const isInExplorer = !!targetElement.closest('[data-type="file-explorer"]')

					if (!thisPlugin.isManualSortingEnabled() || !isInExplorer) {
						original.apply(this, [target, ...args])
						return
					}

					if (thisPlugin._recentExplorerAction) {
						thisPlugin._recentExplorerAction = ''
						return
					}

					const container = this.scrollEl
					const offsetTop = targetElement.offsetTop - container.offsetTop
					const middleAlign = offsetTop - (container.clientHeight * 0.3) + (targetElement.clientHeight / 2)

					container.scrollTo({ top: middleAlign, behavior: 'smooth' })
				},
			}),
		)
	}

	async reloadExplorerPlugin() {
		const fileExplorerPlugin = this.app.internalPlugins.plugins['file-explorer']
		fileExplorerPlugin.disable()
		await fileExplorerPlugin.enable()
		console.log('File Explorer plugin reloaded')

		const toggleSortingClass = async () => {
			const explorerEl = await this.waitForExplorer()
			explorerEl.toggleClass('manual-sorting-enabled', this.isManualSortingEnabled())
		}
		if (this.isManualSortingEnabled()) void toggleSortingClass()

		const configureAutoScrolling = async () => {
			let scrollInterval: number | null = null
			const explorer = await this.waitForExplorer()

			explorer.removeEventListener('dragover', handleDragOver as EventListener)

			if (!this.isManualSortingEnabled()) return
			explorer.addEventListener('dragover', handleDragOver as EventListener)

			function handleDragOver(event: DragEvent) {
				event.preventDefault()
				const rect = explorer.getBoundingClientRect()
				const scrollZone = 50
				const scrollSpeed = 5

				if (event.clientY < rect.top + scrollZone) {
					startScrolling(-scrollSpeed)
				} else if (event.clientY > rect.bottom - scrollZone) {
					startScrolling(scrollSpeed)
				} else {
					stopScrolling()
				}
			}

			document.addEventListener('dragend', stopScrolling)
			document.addEventListener('drop', stopScrolling)
			document.addEventListener('mouseleave', stopScrolling)

			function startScrolling(speed: number) {
				if (scrollInterval) return

				function scrollStep() {
					explorer.scrollTop += speed
					scrollInterval = requestAnimationFrame(scrollStep)
				}

				scrollInterval = requestAnimationFrame(scrollStep)
			}

			function stopScrolling() {
				if (scrollInterval) {
					cancelAnimationFrame(scrollInterval)
					scrollInterval = null
				}
			}
		}
		if (this.isManualSortingEnabled()) void configureAutoScrolling()

		// [Dev mode] Add reload button to file explorer header instead of auto-reveal button
		const addReloadNavButton = async () => {
			await this.waitForExplorer()
			const fileExplorerView = this.getFileExplorerView()
			fileExplorerView.autoRevealButtonEl.style.display = 'none'
			fileExplorerView.headerDom.addNavButton('rotate-ccw', 'Reload app', () => {
				this.app.commands.executeCommandById('app:reload')
			})
		}
		if (process.env.DEV) void addReloadNavButton()

		if (this.app.plugins.getPlugin('folder-notes')) {
			console.log('Reloading Folder Notes plugin')
			await this.app.plugins.disablePlugin('folder-notes')
			void this.app.plugins.enablePlugin('folder-notes')
		}
	}

	patchSortOrderMenu() {
		const thisPlugin = this
		this._unpatchMenu = around(Menu.prototype, {
			showAtMouseEvent: original => function (this: Menu, ...args) {
				const openMenuButton = args[0].target as HTMLElement
				if (openMenuButton.getAttribute('aria-label') === i18next.t('plugins.file-explorer.action-change-sort')
					&& openMenuButton.classList.contains('nav-action-button')
				) {
					const menu = this
					if (thisPlugin.isManualSortingEnabled()) {
						const checkedItem = menu.items.find((item): item is MenuItem => item instanceof MenuItem && item.checked === true)
						if (checkedItem) checkedItem.setChecked(false)
					}

					const sortingMenuSection = MANUAL_SORTING_MODE_ID
					menu.addItem((item: MenuItem) => {
						item.setTitle('Manual sorting')
							.setIcon('pin')
							.setChecked(thisPlugin.isManualSortingEnabled())
							.setSection(sortingMenuSection)
							.onClick(() => {
								if (!thisPlugin.isManualSortingEnabled()) {
									thisPlugin.settings.selectedSortOrder = MANUAL_SORTING_MODE_ID
									void thisPlugin.saveSettings()
									thisPlugin._orderManager.updateOrder()
									void thisPlugin.reloadExplorerPlugin()
								}
							})
					})
					if (thisPlugin.isManualSortingEnabled()) {
						menu.addItem((item: MenuItem) => {
							item.setTitle('Dragging')
								.setIcon('move')
								.setSection(sortingMenuSection)
								.onClick(() => {
									thisPlugin.settings.draggingEnabled = !thisPlugin.settings.draggingEnabled
									void thisPlugin.saveSettings()
									thisPlugin.toogleDragging()
								})

							const checkboxContainerEl = item.dom.createEl('div', { cls: 'menu-item-icon dragging-enabled-checkbox' })
							const checkboxEl = checkboxContainerEl.createEl('input', { type: 'checkbox' })
							checkboxEl.checked = thisPlugin.settings.draggingEnabled
						})
					}
					menu.addItem((item: MenuItem) => {
						item.setTitle('Reset order')
							.setIcon('trash-2')
							.setSection(sortingMenuSection)
							.onClick(() => {
								const fileExplorerView = thisPlugin.getFileExplorerView()
								const prevSelectedSortOrder = fileExplorerView.sortOrder
								new ResetOrderModal(thisPlugin.app, prevSelectedSortOrder, () => {
									thisPlugin._orderManager.resetOrder()
									thisPlugin._orderManager.updateOrder()
									if (thisPlugin.isManualSortingEnabled()) {
										void thisPlugin.reloadExplorerPlugin()
									}
								}).open()
							})
					})
					const menuItems = menu.items
					const menuSeparator = menuItems.splice(8, 1)[0]
					menuItems.splice(0, 0, menuSeparator)
				}
				return original.apply(this, args)
			},
		})
	}
}
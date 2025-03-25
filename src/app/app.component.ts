import * as fc from 'd3fc';
import * as d3 from 'd3';
import { tools } from 'nanocurrency-web';
import { environment } from 'src/environments/environment';

import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';

import { Util } from './util';
import { ConfirmationMessage, NanoWebsocketService } from './ws.service';
import BigNumber from 'bignumber.js';

@Component({
	selector: 'app-root',
	templateUrl: './app.component.html',
	styleUrls: ['./app.component.sass'],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit, OnDestroy {

	electionChart: any;

	// Icons
	downArrow = faChevronDown;
	upArrow = faChevronUp;

	// Intervals
	pageUpdateInterval: any;
	upkeepInterval: any;
	wsHealthCheckInterval: any;

	// Data handling
	readonly data: ElectionChartData[] = [];
	readonly blockToIndex = new Map<string, number>();
	readonly indexToAnimating = new Map<number, number>();
	readonly repToBlocks = new Map<string, Set<string>>();
	readonly latestConfirmations: ConfirmationMessage[] = [];
	readonly representativeStats = new Map<string, RepsetentativeStatItem>();
	readonly electionChartRecentlyRemoved = new Set<string>();
	readonly startTime = new Date().getTime() / 1000;
	readonly maxTrackedElections = 65536; // 2^16 - Memory limit for tracked elections
	readonly spatialIndex = new Map<string, ElectionChartData[]>();
	readonly spatialCellSize = 5; // Size of each spatial cell in time units
	readonly selectedHashes: string[] = []; // Track selected hashes
	readonly selectedHashesVotes = new Map<string, Set<string>>(); // Track votes per hash

	// User defined settings
	fps: number;
	timeframe: number;
	graphStyle: GraphStyle = 2;
	smooth = true;
	useMaxFPS = true;
	showSettings = false;

	// Counters
	index = 0;
	blocks = 0;
	stoppedElections = 0;
	confirmations = 0;
	cps = '0';

	// Environment settings
	readonly network = environment.network;
	readonly maxTimeframeMinutes = 10;
	readonly maxFps = 60;
	readonly hostAccount = environment.hostAccount;
	readonly explorerUrl = environment.explorerUrl;
	readonly repInfoUrl = environment.repInfoUrl;

	constructor(private ws: NanoWebsocketService,
				private changeDetectorRef: ChangeDetectorRef) {
	}

	ngOnDestroy() {
		this.stopInterval();
		if (this.upkeepInterval) {
			clearInterval(this.upkeepInterval);
		}
		if (this.wsHealthCheckInterval) {
			clearInterval(this.wsHealthCheckInterval);
		}
	}

	async ngOnInit() {
		this.startUpkeepInterval();
		this.initSettings();
		this.buildElectionChart();
		this.startInterval();
		await this.ws.updatePrincipalsAndQuorum();
		this.initPrincipals();
		this.start();
	}

	initSettings() {
		this.fps = Math.min(+localStorage.getItem('nv-fps') || 24, this.maxFps);
		this.timeframe = Math.min(+localStorage.getItem('nv-timeframe') || 5, this.maxTimeframeMinutes);
		this.graphStyle = +localStorage.getItem('nv-style') || GraphStyle.HEATMAP;
		this.smooth = (localStorage.getItem('nv-smooth') || 'true') == 'true';
		this.useMaxFPS = (localStorage.getItem('nv-max-fps') || 'true') == 'true';
	}

	initPrincipals() {
		this.ws.principals.forEach(principal => {
			let alias = principal.alias;
			if (principal.account == this.hostAccount) {
				alias = '*** ' + alias;
			}

			this.repToBlocks.set(principal.account, new Set());
			this.representativeStats.set(principal.account, {
				weight: this.ws.principalWeights.get(principal.account) / this.ws.onlineStake,
				alias,
				voteCount: 0,
			});
		});
	}

	getRelativeTimeInSeconds(): number {
		return (new Date().getTime() / 1000) - this.startTime;
	}

	getElectionQuorum(hash: string): number {
		const index = this.blockToIndex.get(hash);
		if (index !== undefined) {
			const item = this.data[index];
			if (item) {
				return item.quorum / 100;
			}
		}
		return 0;
	}

	getElectionReps(hash: string): string[] {
		const votes = this.selectedHashesVotes.get(hash);
		if (!votes) return [];
		return Array.from(votes).map(rep => {
			const stat = this.representativeStats.get(rep);
			return stat ? stat.alias : rep;
		});
	}

	async start() {
		const subjects = await this.ws.subscribe();
		this.wsHealthCheckInterval = setInterval(() => this.ws.checkAndReconnectSocket(), 2000);

		subjects.votes.subscribe(async vote => {
			if (vote.message.timestamp != '18446744073709551615') { // Only count final votes
				return;
			}

			const principalWeight = this.ws.principalWeights.get(vote.message.account);
			if (principalWeight === undefined) {
				return;
			}

			// Get vote type (default to 'normal' if not specified)
			const voteType = vote.message.type || 'normal';
			
			// Ignore votes with type 'late' as requested
			if (voteType === 'late') {
				return;
			}

			const principalWeightPercent = new BigNumber(principalWeight).div(new BigNumber(this.ws.quorumDelta)).times(100);
			const blocks = this.repToBlocks.get(vote.message.account);

			for (const block of vote.message.blocks) {
				// Track votes for selected hashes
				if (this.selectedHashes.includes(block)) {
					if (!this.selectedHashesVotes.has(block)) {
						this.selectedHashesVotes.set(block, new Set());
					}
					this.selectedHashesVotes.get(block).add(vote.message.account);
					this.changeDetectorRef.markForCheck();
				}

				const index = this.blockToIndex.get(block);
				const item = this.data[index];

				// The node is reporting representative votes which are already counted, only count first occurrences
				if (!blocks.has(vote.message.blocks[0])) {
					blocks.add(vote.message.blocks[0]);
					if (index !== undefined && item) {
						const previousQuorum = item.quorum;

						if (previousQuorum < 100) {
							const newQuorum = new BigNumber(previousQuorum).plus(principalWeightPercent);
							if (newQuorum.isGreaterThanOrEqualTo(100)) {
								if (this.smooth) {
									this.indexToAnimating.set(index, 100 - previousQuorum);
								} else {
									item.quorum = 100;
									this.indexToAnimating.delete(index);
								}
							} else {
								if (this.smooth) {
									const previousAnimating = this.indexToAnimating.get(index);
									let newAnimating = principalWeightPercent.toNumber();
									if (previousAnimating) {
										newAnimating = Math.min(principalWeightPercent.plus(previousAnimating).toNumber(), 100);
										if (newAnimating + previousQuorum > 100) {
											newAnimating = 100 - previousQuorum;
										}
									}
									this.indexToAnimating.set(index, newAnimating);
								} else {
									item.quorum = Math.min(principalWeightPercent.plus(previousQuorum).toNumber(), 100);
								}
							}
						}
					} else if (!this.electionChartRecentlyRemoved.has(block)) {
						this.addNewBlock(block, principalWeightPercent.toNumber(), false, voteType);
					}

					this.representativeStats.get(vote.message.account).voteCount++;
				}

				// Remove from selected hashes if confirmed
				if (item?.quorum >= 100 && this.selectedHashes.includes(block)) {
					const idx = this.selectedHashes.indexOf(block);
					this.selectedHashes.splice(idx, 1);
					this.selectedHashesVotes.delete(block);
					this.changeDetectorRef.markForCheck();
				}
			}
		});

		subjects.confirmations.subscribe(async confirmation => {
			const block = confirmation.message.hash;
			const index = this.blockToIndex.get(block);
			const item = this.data[index];
			if (index !== undefined && item) {
				// Mark as having a started election as soon as we receive confirmation
				item.electionStarted = true;
				
				if (this.smooth && !isNaN(item.quorum)) {
					this.indexToAnimating.set(index, 100 - item.quorum);
				} else {
					item.quorum = 100;
				}
			} else {
				this.addNewBlock(block, 100, true, 'normal');
			}
			this.confirmations++;

			const nanoAmount = Number(tools.convert(confirmation.message.amount, 'RAW', 'NANO')).toFixed(8);
			const trailingZeroesCleared = String(+nanoAmount / 1);
			confirmation.message.amount = trailingZeroesCleared;
			if (this.latestConfirmations.unshift(confirmation.message) > 20) {
				this.latestConfirmations.pop();
			}
		});

		subjects.stoppedElections.subscribe(async stoppedElection => {
			const block = stoppedElection.message.hash;
			const index = this.blockToIndex.get(block);
			if (index !== undefined) {
				const item = this.data[index];
				if (item?.quorum < 100) {
					item.quorum = null;
					this.stoppedElections++;
					this.electionChartRecentlyRemoved.add(block);
					setTimeout(() => this.electionChartRecentlyRemoved.delete(block), 500);
				}

				this.blockToIndex.delete(block);
				this.indexToAnimating.delete(index);
			}
		});
	}

	updateSpatialIndex(item: ElectionChartData) {
		const cellKey = Math.floor(item.added / this.spatialCellSize).toString();
		if (!this.spatialIndex.has(cellKey)) {
			this.spatialIndex.set(cellKey, []);
		}
		this.spatialIndex.get(cellKey).push(item);
	}

	addNewBlock(block: string, quorum: number, electionStarted: boolean = false, voteType: string = 'normal') {
		const previousIndex = this.blockToIndex.get(block);
		if (previousIndex) {
			return;
		}

		const index = this.index++;
		const added = this.getRelativeTimeInSeconds();
		this.blockToIndex.set(block, index);

		let item: ElectionChartData;
		if (this.smooth) {
			item = {
				added: added,
				quorum: 0,
				electionStarted: electionStarted,
				hash: block,
				voteType: voteType
			};
			this.data[index] = item;
			this.indexToAnimating.set(index, quorum);
		} else {
			item = {
				added: added,
				quorum,
				electionStarted: electionStarted,
				hash: block,
				voteType: voteType
			};
			this.data[index] = item;
		}
		
		// Add to spatial index for efficient hover detection
		this.updateSpatialIndex(item);

		this.blocks++;

		// Check memory limit
		if (this.blocks > this.maxTrackedElections) {
			this.enforceMemoryLimit();
		}
	}

	async buildElectionChart() {
		const xScale = d3.scaleLinear().domain([0, 1000]);
		const yScale = d3.scaleLinear().domain([0, 101]);

		const yearColorScale = d3
				.scaleSequential()
				.domain([0, 100])
				.interpolator(d3.interpolateRdYlGn);

		const webglColor = (color: string) => {
			if (color) {
				const { r, g, b, opacity } = d3.color(color).rgb();
				return [r / 255, g / 255, b / 255, opacity];
			} else {
				return [0, 0, 0, 0];
			}
		}

		const fillColor = (<any>fc)
				.webglFillColor()
				.value((item: ElectionChartData) => {
					if (!item || item.quorum === null) return [0, 0, 0, 0];
					const color = webglColor(yearColorScale(item.quorum));
					if (item.electionStarted) {
						// Make started elections much brighter
						return [
							Math.min(1, color[0] * 2.5), // Even brighter
							Math.min(1, color[1] * 2.5),
							Math.min(1, color[2] * 2.5),
							color[3]
						];
					}
					return color;
				})
				.data(this.data);

		this.electionChart = document.querySelector('d3fc-canvas');
		
		// Use different point sizes based on election status
		const pointSeries = (<any>fc)
				.seriesWebglPoint()
				.xScale(xScale)
				.yScale(yScale)
				.size((d: ElectionChartData) => d.electionStarted ? 20 : 8) // Even more dramatic size difference
				.crossValue((item: ElectionChartData) => item?.added)
				.mainValue((item: ElectionChartData) => item?.quorum)
				.defined(() => true)
				.equals((_, __) => false)
				.decorate(program => fillColor(program));

		let pixels = null;
		let gl = null;

		d3.select(this.electionChart)
				.on('measure', event => {
					const { width, height } = event.detail;
					xScale.range([0, width]);
					yScale.range([height, 0]);
					gl = this.electionChart.querySelector('canvas').getContext('webgl');
					pointSeries.context(gl);
				})
				.on('draw', () => {
					if (pixels == null) {
						pixels = new Uint8Array(
							gl.drawingBufferWidth * gl.drawingBufferHeight * 4
						);
					}

					const now = this.getRelativeTimeInSeconds();
					const start = now - (60 * this.timeframe);

					// Handle animation
					if (this.smooth) {
						for (const [index, animating] of this.indexToAnimating.entries()) {
							// Delete the queued animation if the target is no longer present
							const item = this.data[index];
							if (!item || isNaN(animating) || item.quorum >= 100) {
								this.indexToAnimating.delete(index);
								continue;
							}

							// Animate only the ones which are currently rendered, just increment the quorum of others
							if (start < item.added) {
								// Interpolate linear increments down to a minimum increment of 0.13 to save resources
								const increment = Math.max(Util.lerp(0, item.quorum + animating, animating / (item.quorum + animating) / 20), 0.1);

								// If the increment is smaller than the remainder animation, keep animating
								// Else add the rest of remaining animation. Cap quorum at 100
								if (animating > increment) {
									item.quorum = Math.min(item.quorum + increment, 100);
									this.indexToAnimating.set(index, animating - increment);
								} else {
									item.quorum = Math.min(item.quorum + animating, 100);
									this.indexToAnimating.delete(index);
								}
							} else {
								item.quorum = Math.min(item.quorum + animating, 100);
								this.indexToAnimating.delete(index);
							}
						}
					}

					// Fill out the timeline even though new data hasn't come by
					const lastAdded = this.data[this.data.length - 1].added;
					if (now > lastAdded) {
						const nextIndex = this.index++;
						this.data[nextIndex] = {
							added: now,
							quorum: null,
							electionStarted: false,
							hash: '',
							voteType: '',
						};
					}

					// Binary search the nearest index to the current minimum displayed area
					const lastTooOldIndex = Util.binarySearchNearestIndex(this.data, 'added', start);
					let displayedData;
					if (lastTooOldIndex > 0) {
						displayedData = this.data.slice(lastTooOldIndex);
					} else {
						displayedData = this.data;
					}

					// Set data to color function and chart
					fillColor.data(displayedData);
					pointSeries(displayedData);

					// Set the displayed area to be from start time to current time
					xScale.domain([ Math.max(start, 0), now ]);

					gl.readPixels(
						0,
						0,
						gl.drawingBufferWidth,
						gl.drawingBufferHeight,
						gl.RGBA,
						gl.UNSIGNED_BYTE,
						pixels
					);
				})
				.on('mousemove', (event) => {
					const [x, y] = d3.pointer(event);
					const xValue = xScale.invert(x);
					const yValue = yScale.invert(y);
					
					// Use spatial index to limit search
					const cellKey = Math.floor(xValue / this.spatialCellSize).toString();
					const nearbyItems = this.spatialIndex.get(cellKey) || [];
					
					// Find the closest point in the limited set
					let closest = null;
					let minDistance = Infinity;
					
					for (const item of nearbyItems) {
						if (!item) continue;
						
						const dx = Math.abs(item.added - xValue);
						const dy = Math.abs(item.quorum - yValue);
						const distance = Math.sqrt(dx * dx + dy * dy);
						
						if (distance < minDistance && distance < 0.05) { // Threshold for "close enough"
							minDistance = distance;
							closest = item;
						}
					}
					
					// Show tooltip with hash if a point is found
					const tooltip = document.getElementById('hash-tooltip');
					if (closest && tooltip) {
						tooltip.style.left = (x + 10) + 'px';
						tooltip.style.top = (y + 10) + 'px';
						tooltip.style.display = 'block';
						tooltip.innerText = closest.hash;
					} else if (tooltip) {
						tooltip.style.display = 'none';
					}
				})
				.on('mouseleave', () => {
					const tooltip = document.getElementById('hash-tooltip');
					if (tooltip) {
						tooltip.style.display = 'none';
					}
				})
				.on('click', (event) => {
					const [x, y] = d3.pointer(event);
					const xValue = xScale.invert(x);
					const yValue = yScale.invert(y);
					
					// Use spatial index to limit search
					const cellKey = Math.floor(xValue / this.spatialCellSize).toString();
					const nearbyItems = this.spatialIndex.get(cellKey) || [];
					
					// Find the closest point in the limited set
					let closest = null;
					let minDistance = Infinity;
					
					for (const item of nearbyItems) {
						if (!item || item.quorum === null) continue;
						
						const dx = Math.abs(item.added - xValue);
						const dy = Math.abs(item.quorum - yValue);
						const distance = Math.sqrt(dx * dx + dy * dy);
						
						if (distance < minDistance && distance < 0.5) { // Increased threshold for easier clicking
							minDistance = distance;
							closest = item;
						}
					}
					
					// Add hash to selected hashes if found
					if (closest && closest.hash) {
						const existingIndex = this.selectedHashes.indexOf(closest.hash);
						if (existingIndex !== -1) {
							// If already selected, remove it
							this.selectedHashes.splice(existingIndex, 1);
							this.selectedHashesVotes.delete(closest.hash);
						} else {
							// Add new hash
							this.selectedHashes.unshift(closest.hash);
							if (this.selectedHashes.length > 20) {
								const removed = this.selectedHashes.pop();
								this.selectedHashesVotes.delete(removed);
							}
							// Collect existing votes for this hash
							this.collectExistingVotes(closest.hash);
						}
						this.changeDetectorRef.detectChanges(); // Force change detection
					}
				});
	}

	changeUseMaxFps() {
		this.useMaxFPS = !this.useMaxFPS;
		localStorage.setItem('nv-max-fps', this.useMaxFPS ? 'true' : 'false');
		this.startInterval();
	}

	changeFps(e: any) {
		this.fps = e.target.value;
		this.startInterval();
		localStorage.setItem('nv-fps', String(this.fps));
	}

	changeTimeframe(e: any) {
		this.timeframe = e.target.value;
		localStorage.setItem('nv-timeframe', String(this.timeframe));
	}

	changeGraphStyle(style: GraphStyle) {
		this.graphStyle = style;
		localStorage.setItem('nv-style', String(this.graphStyle));
		this.buildElectionChart();
	}

	changeSmooth() {
		this.smooth = !this.smooth;
		localStorage.setItem('nv-smooth', this.smooth ? 'true' : 'false');
		if (!this.smooth) {
			this.clearAnimatingQueue();
		}
	}

	clearAnimatingQueue() {
		for (const [index, animating] of this.indexToAnimating.entries()) {
			const item = this.data[index];
			if (item) {
				item.quorum = Math.min(item.quorum + animating, 100);
			}
		}
		this.indexToAnimating.clear();
	}

	async startInterval() {
		this.stopInterval();
		if (this.useMaxFPS) {
			const startAnimation = () => {
				this.update();
				this.pageUpdateInterval = requestAnimationFrame(startAnimation);
			}
			startAnimation();
		} else if (this.fps != 0) {
			this.pageUpdateInterval = setInterval(() => {
				this.update();
			}, 1000 / this.fps);
		}
	}

	update() {
		if (this.data.length > 0) {
			const now = this.getRelativeTimeInSeconds();
			this.cps = (this.confirmations / now).toFixed(4);
			this.electionChart.requestRedraw();
			this.changeDetectorRef.markForCheck();
		}
	}

	stopInterval() {
		if (this.pageUpdateInterval) {
			clearInterval(this.pageUpdateInterval);
			cancelAnimationFrame(this.pageUpdateInterval);
			this.pageUpdateInterval = undefined;
		}
	}

	startUpkeepInterval() {
		this.upkeepInterval = setInterval(async () => {
			console.log('Upkeep triggered...');
			await this.ws.updatePrincipalsAndQuorum();

			const now = this.getRelativeTimeInSeconds();
			const tooOld = Math.max(now - (60 * this.maxTimeframeMinutes), 0);
			let lastTooOldIndex = 0;
			for (let i = 0; i < this.data.length; i++) {
				const item = this.data[i];
				if (item && tooOld > item?.added) {
					delete this.data[i];
					lastTooOldIndex = i;
				}
			}

			for (const index of this.indexToAnimating.keys()) {
				if (index < lastTooOldIndex) {
					this.indexToAnimating.delete(index);
				}
			}

			for (const principal of this.ws.principals) {
				const stat = this.representativeStats.get(principal.account);
				if (stat) {
					stat.alias = principal.alias;
					stat.weight = this.ws.principalWeights.get(principal.account) / this.ws.onlineStake;
				}
			}
		}, 1000 * 60 * this.maxTimeframeMinutes);
	}

	enforceMemoryLimit() {
		if (this.data.length <= this.maxTrackedElections) {
			return;
		}
		
		// Calculate how many items to remove (20% of max to avoid doing this too often)
		const removeCount = Math.floor(this.maxTrackedElections * 0.2);
		
		// Find oldest items
		const indices = Object.keys(this.data)
			.map(Number)
			.filter(i => this.data[i] !== undefined)
			.sort((a, b) => this.data[a].added - this.data[b].added)
			.slice(0, removeCount);
		
		// Remove these items
		for (const index of indices) {
			// Find and remove from blockToIndex
			for (const [hash, idx] of this.blockToIndex.entries()) {
				if (idx === index) {
					this.blockToIndex.delete(hash);
					break;
				}
			}
			
			// Remove from spatial index
			const item = this.data[index];
			if (item) {
				const cellKey = Math.floor(item.added / this.spatialCellSize).toString();
				const cell = this.spatialIndex.get(cellKey);
				if (cell) {
					const itemIndex = cell.indexOf(item);
					if (itemIndex >= 0) {
						cell.splice(itemIndex, 1);
					}
					if (cell.length === 0) {
						this.spatialIndex.delete(cellKey);
					}
				}
			}
			
			// Remove from data and animation queue
			delete this.data[index];
			this.indexToAnimating.delete(index);
		}
		
		console.log(`Memory limit reached: removed ${removeCount} oldest blocks`);
	}

	removeSelectedHash(hash: string) {
		const index = this.selectedHashes.indexOf(hash);
		if (index !== -1) {
			this.selectedHashes.splice(index, 1);
			this.selectedHashesVotes.delete(hash);
			this.changeDetectorRef.detectChanges();
		}
	}

	// Method to collect all current votes for a hash
	collectExistingVotes(hash: string) {
		const votes = new Set<string>();
		
		// Check all representatives for votes on this hash
		for (const [rep, blocks] of this.repToBlocks.entries()) {
			if (blocks.has(hash)) {
				votes.add(rep);
			}
		}
		
		this.selectedHashesVotes.set(hash, votes);
	}

}

export interface ElectionChartData {
	added: number;
	quorum: number;
	electionStarted: boolean;
	hash: string;
	voteType: string;
}

export interface RepsetentativeStatItem {
	weight: number;
	alias: string;
	voteCount: number;
}

export enum GraphStyle {
	X0,
	X1,
	HEATMAP = 2,
}

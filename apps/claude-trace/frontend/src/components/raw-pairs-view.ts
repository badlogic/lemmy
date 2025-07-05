import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { RawPair } from "../../../src/types";

@customElement("raw-pairs-view")
export class RawPairsView extends LitElement {
	@property({ type: Array }) rawPairs: RawPair[] = [];

	// Disable shadow DOM to use global Tailwind styles
	createRenderRoot() {
		return this;
	}

	render() {
		if (this.rawPairs.length === 0) {
			return html`<div class="text-vs-muted">No raw pairs found.</div>`;
		}

		// Filter out pairs with null responses for display
		const validPairs = this.rawPairs.filter((pair) => pair.response !== null);

		return html`
			<div>
				${validPairs.map(
					(pair, index) => html`
						<div class="mt-8 first:mt-0">
							<!-- Pair Header -->
							<div class="border border-vs-highlight p-4 mb-0">
								<div class="text-vs-assistant font-bold">
									${pair.request.method} ${this.getUrlPath(pair.request.url)}
								</div>
								<div class="text-vs-muted">
									Raw Pair ${index + 1} • ${this.getModelName(pair)} • Status ${pair.response!.status_code} •
									${new Date(pair.logged_at).toLocaleString()}
								</div>
							</div>

							<!-- Request Section -->
							<div class="px-4 mt-4">
								<div class="mb-4">
									<div
										class="cursor-pointer text-vs-user font-bold hover:text-white transition-colors"
										@click=${(e: Event) => this.toggleContent(e)}
									>
										<span class="mr-2">[+]</span>
										<span>Request</span>
									</div>
									<div class="hidden mt-2">
										<div class="bg-vs-bg-secondary p-4 text-vs-text overflow-x-auto">
											<pre class="whitespace-pre text-vs-text m-0">${this.formatJson(pair.request)}</pre>
										</div>
									</div>
								</div>

								<!-- Response Section -->
								<div class="mb-4">
									<div
										class="cursor-pointer text-vs-assistant font-bold hover:text-white transition-colors"
										@click=${(e: Event) => this.toggleContent(e)}
									>
										<span class="mr-2">[+]</span>
										<span>Response</span>
									</div>
									<div class="hidden mt-2">
										<div class="bg-vs-bg-secondary p-4 text-vs-text overflow-x-auto">
											<pre class="whitespace-pre text-vs-text m-0">${this.formatJson(pair.response)}</pre>
										</div>
									</div>
								</div>

								<!-- SSE Events Section -->
								${pair.response!.events && pair.response!.events.length > 0
									? html`
											<div class="mb-4">
												<div
													class="cursor-pointer text-vs-type font-bold hover:text-white transition-colors"
													@click=${(e: Event) => this.toggleContent(e)}
												>
													<span class="mr-2">[+]</span>
													<span>SSE Events (${pair.response!.events.length})</span>
												</div>
												<div class="hidden mt-2">
													<div class="bg-vs-bg-secondary p-4 text-vs-text overflow-x-auto">
														<pre class="whitespace-pre text-vs-text m-0">
${this.formatJson(pair.response!.events)}</pre
														>
													</div>
												</div>
											</div>
										`
									: ""}
							</div>
						</div>
					`,
				)}
			</div>
		`;
	}

	private getUrlPath(url: string): string {
		try {
			return new URL(url).pathname;
		} catch {
			return url;
		}
	}

	private getModelName(pair: RawPair): string {
		// Try to extract from Bedrock URL first
		if (pair.request.url && pair.request.url.includes("bedrock-runtime")) {
			const urlMatch = pair.request.url.match(/\/model\/([^\/]+)/);
			if (urlMatch && urlMatch[1]) {
				return this.normalizeModelName(urlMatch[1]);
			}
		}

		// Try to get model from request body
		if (pair.request.body && pair.request.body.model) {
			return this.normalizeModelName(pair.request.body.model);
		}

		// Default fallback
		return "unknown";
	}

	private normalizeModelName(modelName: string): string {
		if (!modelName) return "unknown";

		// Handle Bedrock model names
		if (modelName.startsWith("us.anthropic.")) {
			// Convert "us.anthropic.claude-3-5-sonnet-20241022-v1:0" to "claude-3-5-sonnet-20241022"
			const match = modelName.match(/us\.anthropic\.([^:]+)/);
			if (match && match[1]) {
				return match[1];
			}
		}

		// Return as-is for other formats
		return modelName;
	}

	private formatJson(obj: any): string {
		try {
			return JSON.stringify(obj, null, 2);
		} catch {
			return String(obj);
		}
	}

	private toggleContent(e: Event) {
		const header = e.currentTarget as HTMLElement;
		const content = header.nextElementSibling as HTMLElement;
		const toggle = header.querySelector("span:first-child") as HTMLElement;

		if (content && toggle) {
			const isHidden = content.classList.contains("hidden");
			content.classList.toggle("hidden", !isHidden);
			toggle.textContent = isHidden ? "[-]" : "[+]";
		}
	}
}

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ProcessedPair } from "../../../src/shared-conversation-processor";

@customElement("json-view")
export class JsonView extends LitElement {
	@property({ type: Array }) processedPairs: ProcessedPair[] = [];

	// Disable shadow DOM to use global CSS
	createRenderRoot() {
		return this;
	}

	render() {
		if (this.processedPairs.length === 0) {
			return html`<div class="text-vs-muted">No processed pairs found.</div>`;
		}

		return html`
			<div>
				${this.processedPairs.map(
					(pair, index) => html`
						<div class="mt-8 first:mt-0">
							<!-- Pair Header -->
							<div class="border border-vs-highlight p-4 mb-0">
								<div class="text-vs-assistant font-bold">${pair.model}</div>
								<div class="text-vs-muted">
									Pair ${index + 1} • ${pair.isStreaming ? "streaming" : "non-streaming"} •
									${new Date(pair.timestamp).toLocaleString()}
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
										<span>Request (MessageCreateParams)</span>
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
										<span>Response (Message)${pair.isStreaming ? " - Reconstructed from SSE" : ""}</span>
									</div>
									<div class="hidden mt-2">
										<div class="bg-vs-bg-secondary p-4 text-vs-text overflow-x-auto">
											<pre class="whitespace-pre text-vs-text m-0">${this.formatJson(pair.response)}</pre>
										</div>
									</div>
								</div>
							</div>
						</div>
					`,
				)}
			</div>
		`;
	}

	private formatJson(obj: any): string {
		try {
			return JSON.stringify(obj, null, 2);
		} catch (e) {
			return `Error formatting JSON: ${e}`;
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

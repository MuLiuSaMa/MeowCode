import { useMemo } from "react";
import { LuExternalLink } from "react-icons/lu";
import type { ToolViewProps } from "./types";
import { asRecord, parseWebFetchOutput, parseWebSearchOutput, textArg } from "./parse";
import { OutputText, ToolBadge, ToolNote } from "./parts";
import { Markdown } from "../ui/Markdown";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function openExternal(url: string) {
  void window.meow.openExternal(url);
}

export function WebSearchView({ item, status }: ToolViewProps) {
  const output = item.output ?? "";
  const parsed = useMemo(() => parseWebSearchOutput(output), [output]);
  if (status === "failed") {
    return (
      <div className="mc-tv">
        <OutputText text={output} error />
      </div>
    );
  }
  if (!parsed.results.length) {
    return (
      <div className="mc-tv">
        {parsed.notes.map((note, index) => (
          <ToolNote key={index}>{note}</ToolNote>
        ))}
        {!parsed.notes.length ? <OutputText text={output} /> : null}
      </div>
    );
  }
  return (
    <div className="mc-tv">
      <div className="mc-tv__cards">
        {parsed.results.map((hit, index) => (
          <button
            type="button"
            className="mc-tv__card"
            key={`${hit.url}-${index}`}
            title={hit.url}
            onClick={() => openExternal(hit.url)}
          >
            <span className="mc-tv__cardhead">
              <span className="mc-tv__cardtitle">{hit.title || hostnameOf(hit.url)}</span>
              <LuExternalLink size={11} className="mc-tv__cardicon" aria-hidden="true" />
            </span>
            <span className="mc-tv__cardhost">{hostnameOf(hit.url)}</span>
            {hit.excerpt ? <span className="mc-tv__cardtext">{hit.excerpt}</span> : null}
          </button>
        ))}
      </div>
      {parsed.notes.map((note, index) => (
        <ToolNote key={index}>{note}</ToolNote>
      ))}
    </div>
  );
}

export function WebFetchView({ item, status, t }: ToolViewProps) {
  const output = item.output ?? "";
  const parsed = useMemo(() => parseWebFetchOutput(output), [output]);
  if (status === "failed") {
    return (
      <div className="mc-tv">
        <OutputText text={output} error />
      </div>
    );
  }
  const url = parsed.url || textArg(asRecord(item.input), "url");
  return (
    <div className="mc-tv">
      {url ? (
        <div className="mc-tv__pathrow">
          <button
            type="button"
            className="mc-tv__path mc-tv__weblink"
            title={url}
            onClick={() => openExternal(url)}
          >
            {url}
          </button>
          {parsed.status ? (
            <ToolBadge tone={parsed.status >= 400 ? "del" : "muted"}>HTTP {parsed.status}</ToolBadge>
          ) : null}
        </div>
      ) : null}
      {parsed.body ? (
        <div className="mc-tv__markdown" data-scroll="true">
          <Markdown content={parsed.body} />
        </div>
      ) : (
        <ToolNote>{t("tool.emptyOutput")}</ToolNote>
      )}
    </div>
  );
}

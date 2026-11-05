import { useMemo } from "react";
import {
  LuCircle,
  LuCircleCheck,
  LuCircleX,
  LuLoaderCircle,
} from "react-icons/lu";
import type { ToolViewProps } from "./types";
import {
  asRecord,
  parseAskAnswers,
  parseAskQuestions,
  parseToolSearchOutput,
  textArg,
} from "./parse";
import { OutputText, ToolBadge, ToolNote } from "./parts";
import { Markdown } from "../ui/Markdown";

export function AskUserView({ item, status, t }: ToolViewProps) {
  const questions = useMemo(() => parseAskQuestions(item.input), [item.input]);
  const answers = useMemo(() => parseAskAnswers(item.output), [item.output]);
  const waiting = status === "running";
  if (!questions.length) {
    return (
      <div className="mc-tv">
        <OutputText text={item.output ?? ""} error={status === "failed"} />
        {!item.output ? <ToolNote>{t("tool.emptyOutput")}</ToolNote> : null}
      </div>
    );
  }
  return (
    <div className="mc-tv mc-tv__qa">
      {status === "failed" && item.output ? <OutputText text={item.output} error /> : null}
      {questions.map((question, index) => {
        const answer = answers[index]?.trim() ?? "";
        return (
          <div className="mc-tv__qaitem" key={index}>
            <p className="mc-tv__question">{question.question}</p>
            {!answer && question.options.length ? (
              <div className="mc-tv__options">
                {question.options.map((option) => (
                  <span className="mc-tv__option" key={option}>
                    {option}
                  </span>
                ))}
              </div>
            ) : null}
            <p className="mc-tv__answer" data-empty={!answer || undefined}>
              {answer || (waiting ? t("tool.view.waitingAnswer") : t("tool.view.unanswered"))}
            </p>
          </div>
        );
      })}
    </div>
  );
}

type PlanStep = { title: string; status: string };

function planSteps(input: unknown): { steps: PlanStep[]; explanation?: string } {
  const args = asRecord(input);
  const steps = Array.isArray(args.steps)
    ? args.steps.flatMap((item) => {
        const record = asRecord(item);
        const title = typeof record.title === "string" ? record.title.trim() : "";
        if (!title) return [];
        return [{ title, status: typeof record.status === "string" ? record.status : "pending" }];
      })
    : [];
  const explanation =
    typeof args.explanation === "string" && args.explanation.trim()
      ? args.explanation.trim()
      : undefined;
  return { steps, explanation };
}

export function PlanView({ item }: ToolViewProps) {
  const { steps, explanation } = useMemo(() => planSteps(item.input), [item.input]);
  if (!steps.length) return null;
  return (
    <div className="mc-tv">
      <div className="mc-tv__list mc-tv__plan">
        {steps.map((step, index) => (
          <div className="mc-tv__entry" data-state={step.status} key={`${index}-${step.title}`}>
            {step.status === "completed" ? (
              <LuCircleCheck size={14} className="mc-tv__icon" data-tone="ok" aria-hidden="true" />
            ) : step.status === "in_progress" ? (
              <LuLoaderCircle size={14} className="mc-tv__icon mc-tv__spin" aria-hidden="true" />
            ) : step.status === "cancelled" ? (
              <LuCircleX size={14} className="mc-tv__icon" data-tone="bad" aria-hidden="true" />
            ) : (
              <LuCircle size={14} className="mc-tv__icon" aria-hidden="true" />
            )}
            <span className="mc-tv__entryname" data-done={step.status === "completed" || undefined}>
              {step.title}
            </span>
          </div>
        ))}
      </div>
      {explanation ? <ToolNote>{explanation}</ToolNote> : null}
    </div>
  );
}

export function TaskView({ item, status, t }: ToolViewProps) {
  const args = asRecord(item.input);
  const description = textArg(args, "description").trim();
  const prompt = textArg(args, "prompt").trim();
  const mode = textArg(args, "mode").trim();
  const agentType = textArg(args, "agent_type").trim();
  const agentId = textArg(args, "agent_id").trim();
  return (
    <div className="mc-tv">
      <div className="mc-tv__pathrow">
        <span className="mc-tv__path">{description || t("tool.task")}</span>
        {mode ? <ToolBadge tone="muted">{mode}</ToolBadge> : null}
        {agentType ? <ToolBadge tone="muted">{agentType}</ToolBadge> : null}
        {agentId ? <ToolBadge tone="muted">{agentId}</ToolBadge> : null}
      </div>
      {prompt ? <OutputText text={prompt} /> : null}
      {status === "failed" ? (
        <OutputText text={item.output ?? ""} error />
      ) : item.output ? (
        <OutputText text={item.output} />
      ) : (
        <ToolNote>{status === "running" ? t("tool.waitingOutput") : t("tool.outputNotSaved")}</ToolNote>
      )}
    </div>
  );
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\n+/, "");
}

export function MemoryView({ item, status, t }: ToolViewProps) {
  const args = asRecord(item.input);
  const scope = textArg(args, "scope");
  const name = textArg(args, "name");
  const output = item.output ?? "";
  const isRead = item.tool === "memory_read";
  return (
    <div className="mc-tv">
      {name ? (
        <div className="mc-tv__pathrow">
          <span className="mc-tv__path">{name}</span>
          {scope ? <ToolBadge tone="muted">{scope}</ToolBadge> : null}
        </div>
      ) : null}
      {status === "failed" ? (
        <OutputText text={output} error />
      ) : isRead ? (
        output ? (
          <div className="mc-tv__markdown" data-scroll="true">
            <Markdown content={stripFrontmatter(output)} />
          </div>
        ) : (
          <ToolNote>{t("tool.outputNotSaved")}</ToolNote>
        )
      ) : output ? (
        <OutputText text={output} />
      ) : (
        <ToolNote>{t("tool.emptyOutput")}</ToolNote>
      )}
    </div>
  );
}

export function ToolSearchView({ item, t }: ToolViewProps) {
  const parsed = useMemo(() => parseToolSearchOutput(item.output ?? ""), [item.output]);
  return (
    <div className="mc-tv">
      {parsed.items.length ? (
        <div className="mc-tv__list">
          {parsed.items.map((tool) => (
            <div className="mc-tv__entry" key={tool.name}>
              <span className="mc-tv__toolname">{tool.name}</span>
              <span className="mc-tv__entrydir">{tool.description}</span>
            </div>
          ))}
        </div>
      ) : (
        <OutputText text={item.output ?? ""} />
      )}
      {parsed.header && parsed.items.length ? <ToolNote>{parsed.header}</ToolNote> : null}
      {parsed.notes.map((note, index) => (
        <ToolNote key={index}>{note}</ToolNote>
      ))}
      {!item.output ? <ToolNote>{t("tool.emptyOutput")}</ToolNote> : null}
    </div>
  );
}

export function ContextStatusView({ item }: ToolViewProps) {
  return (
    <div className="mc-tv">
      <OutputText text={item.output ?? ""} />
    </div>
  );
}

export function AdmitView({ item, status, t }: ToolViewProps) {
  const args = asRecord(item.input);
  const tier = textArg(args, "tier");
  const shape = textArg(args, "task_shape");
  const lanes = Array.isArray(args.lanes) ? args.lanes : [];
  return (
    <div className="mc-tv">
      {tier || shape ? (
        <div className="mc-tv__pathrow">
          {shape ? <span className="mc-tv__path">{shape}</span> : null}
          {tier ? <ToolBadge tone="muted">{tier}</ToolBadge> : null}
        </div>
      ) : null}
      {lanes.length ? (
        <div className="mc-tv__list">
          {lanes.map((lane, index) => {
            const record = asRecord(lane);
            const id = textArg(record, "id");
            const objective = textArg(record, "objective");
            return (
              <div className="mc-tv__entry" key={`${id}-${index}`}>
                <span className="mc-tv__toolname">{id || `#${index + 1}`}</span>
                <span className="mc-tv__entrydir">{objective}</span>
              </div>
            );
          })}
        </div>
      ) : null}
      {status === "failed" ? (
        <OutputText text={item.output ?? ""} error />
      ) : item.output ? (
        <OutputText text={item.output} />
      ) : (
        <ToolNote>{t("tool.emptyOutput")}</ToolNote>
      )}
    </div>
  );
}

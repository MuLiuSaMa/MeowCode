import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineImage } from "../api";
import { loadMarketplaceCatalog } from "../data/marketplaceCatalog";
import { loadPluginIconMap } from "../data/pluginIcons";
import { LuCheck, LuCopy, LuFolder, LuPencil, LuPuzzle, LuSparkles, LuUndo2 } from "react-icons/lu";
import { PluginSlot } from "../plugins/PluginSlot";
import { FileIcon } from "./ui/FileIcon";
import { parseUserMessage } from "../user-references";
import "./UserBubble.css";

/** 引用的附件/技能/插件各占首部一行，可连续多行；空行之后才是用户正文 */
export function UserBubble({
  content,
  images,
  navKey,
  messageIndex,
  checkpointId,
  checkpointHasSnapshot,
  onRewind,
  onEdit,
}: {
  content: string;
  images?: TimelineImage[];
  /** 对话浏览条跳转锚点（时间线 key），渲染成 data-nl-key */
  navKey?: string;
  /** 历史回放时的消息下标；会话全文检索跳转锚点（data-message-index）用 */
  messageIndex?: number;
  /**
   * 挂在这条用户消息上的自动检查点（回合开始打点）：hover 显示「回滚到此处」。
   * 没有文件快照时直接按「仅对话」回滚，否则先开预览（both）。
   */
  checkpointId?: string;
  checkpointHasSnapshot?: boolean;
  onRewind?: (checkpointId: string) => void;
  /**
   * 就地编辑并在该点重跑：只改正文，首部引用块（附件/技能/命令标记）原样保留。
   * 没有检查点时无法定位截断点，因此该入口只在 checkpointId 存在时出现。
   */
  onEdit?: (checkpointId: string, content: string) => void;
}) {
  const { t } = useTranslation("chat");
  /**
   * 解析结果只跟 content 有关。历史消息在流式期间每秒会被重渲染 20 次左右，
   * 不缓存的话每条历史用户消息都要重新 split("\n") 一遍。
   */
  const parsed = useMemo(() => parseUserMessage(content), [content]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [pluginIcons, setPluginIcons] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const copyText = parsed.body.trim() ? parsed.body : content;
  const canEdit = Boolean(checkpointId && onEdit);
  /**
   * 首部引用块是 content 的前缀：`parseUserMessage` 的 body 取的是
   * `lines.slice(index).join("\n")`，也就是 content 的后缀，所以长度差正好是首部
   * （含分隔空行）。编辑只替换正文，标记行原样带回。
   */
  const header = parsed.body === content ? "" : content.slice(0, content.length - parsed.body.length);

  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyMessage = async () => {
    if (!copyText.trim()) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // 剪贴板不可用：不打断阅读
    }
  };

  /** 进入编辑：只编辑正文，首部引用块在提交时原样拼回。 */
  const beginEdit = () => {
    setDraft(parsed.body);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
  };

  const submitEdit = () => {
    const next = draft.trim();
    if (!next || !checkpointId) return;
    setEditing(false);
    setDraft("");
    onEdit?.(checkpointId, `${header}${next}`);
  };

  useEffect(() => {
    if (!editing) return;
    const element = editorRef.current;
    if (!element) return;
    // 光标落到末尾：编辑通常是在原文后追加一句
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    const element = editorRef.current;
    if (!element) return;
    // 自动高度：内容多高就多高，不出现内部滚动条（配合 CSS overflow:hidden）
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [editing, draft]);

  useEffect(() => {
    if (!parsed.command && parsed.chips.length === 0) {
      setIcons({});
      return;
    }
    let live = true;
    void Promise.all([
      loadMarketplaceCatalog()
        .then((catalog) => catalog.icons)
        .catch(() => ({})),
      loadPluginIconMap(),
    ]).then(([catalogIcons, installedPluginIcons]) => {
      if (!live) return;
      setIcons(catalogIcons);
      setPluginIcons(installedPluginIcons);
    });
    return () => {
      live = false;
    };
    // parsed 每次渲染都是新对象，用 content 作为触发条件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  /** 插件图标：已安装插件表优先，其次市场图标表（内置/自建插件不在市场里） */
  const iconOf = (kind: "plugin" | "skill", id: string): string | undefined =>
    (kind === "plugin" ? pluginIcons[id] : undefined) ?? icons[`${kind}:${id}`];

  const hasChips = Boolean(parsed.command) || parsed.attachments.length > 0 || parsed.chips.length > 0;

  return (
    <div
      className="mc-userrow"
      data-nl-key={navKey}
      {...(messageIndex !== undefined ? { "data-message-index": String(messageIndex) } : {})}
    >
      <PluginSlot
        name="message.user.before"
        props={{ content, images, messageIndex }}
      />
      <div className={`mc-userbubble${editing ? " mc-userbubble--editing" : ""}`}>
        {images?.length ? (
          <div className="mc-userbubble__images">
            {images.map((image, index) => (
              <img
                key={`${image.name ?? "img"}-${index}`}
                className="mc-userbubble__image"
                src={image.src ?? image.dataUrl}
                alt={image.name ?? t("user.imageAlt")}
              />
            ))}
          </div>
        ) : null}
        {hasChips ? (
          <div className="mc-userbubble__skillrow">
            {parsed.command ? (
              <span className="mc-skillchip" title={`/${parsed.command.command}`}>
                {iconOf("plugin", parsed.command.pluginId) ? (
                  <img
                    src={iconOf("plugin", parsed.command.pluginId)}
                    alt=""
                    className="mc-skillchip__icon"
                  />
                ) : (
                  <LuPuzzle size={11} />
                )}
                <span className="mc-skillchip__name">{parsed.command.name}</span>
                <span className="mc-skillchip__cmd">/{parsed.command.command}</span>
              </span>
            ) : null}
            {parsed.attachments.map((attachment) => (
              <span
                className="mc-skillchip mc-skillchip--file"
                key={`file:${attachment.path}`}
                title={attachment.path}
              >
                {attachment.isDirectory ? (
                  <LuFolder size={11} className="mc-skillchip__icon" />
                ) : (
                  <FileIcon path={attachment.path || attachment.name} size={12} />
                )}
                <span className="mc-skillchip__name">{attachment.name}</span>
              </span>
            ))}
            {parsed.chips.map((chip) => {
              const icon = iconOf(chip.kind, chip.id);
              return (
                <span className="mc-skillchip" key={`${chip.kind}:${chip.id}`}>
                  {icon ? (
                    <img src={icon} alt="" className="mc-skillchip__icon" />
                  ) : chip.kind === "skill" ? (
                    <LuSparkles size={11} />
                  ) : (
                    <LuPuzzle size={11} />
                  )}
                  <span className="mc-skillchip__name">{chip.name}</span>
                </span>
              );
            })}
          </div>
        ) : null}
        {editing ? (
          <div className="mc-userbubble__edit">
            <textarea
              ref={editorRef}
              className="mc-userbubble__editor"
              value={draft}
              rows={1}
              aria-label={t("checkpoint.edit")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEdit();
                  return;
                }
                // 编辑框在历史里，用显式组合键提交，避免误触把半句话发出去
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submitEdit();
                }
              }}
            />
            <div className="mc-userbubble__editactions">
              <span className="mc-userbubble__edithint">{t("checkpoint.editHint")}</span>
              <button
                type="button"
                className="mc-userbubble__editbtn"
                onClick={cancelEdit}
              >
                {t("checkpoint.cancel")}
              </button>
              <button
                type="button"
                className="mc-userbubble__editbtn mc-userbubble__editbtn--primary"
                disabled={!draft.trim()}
                onClick={submitEdit}
              >
                {t("checkpoint.editSend")}
              </button>
            </div>
          </div>
        ) : parsed.body ? (
          parsed.body
        ) : null}
      </div>
      <div className="mc-userbubble__pluginactions">
        <button
          type="button"
          className="mc-userbubble__rewind"
          aria-label={t("turnFooter.copyPlain")}
          title={t("turnFooter.copyPlain")}
          onClick={() => void copyMessage()}
        >
          {copied ? <LuCheck size={13} aria-hidden="true" /> : <LuCopy size={13} aria-hidden="true" />}
        </button>
        {canEdit && !editing ? (
          <button
            type="button"
            className="mc-userbubble__rewind"
            aria-label={t("checkpoint.edit")}
            title={t("checkpoint.edit")}
            onClick={beginEdit}
          >
            <LuPencil size={13} aria-hidden="true" />
          </button>
        ) : null}
        {checkpointId && onRewind ? (
          <button
            type="button"
            className="mc-userbubble__rewind"
            aria-label={t("checkpoint.rewind")}
            title={
              checkpointHasSnapshot
                ? t("checkpoint.rewindToHere")
                : t("checkpoint.rewindConversationOnly")
            }
            onClick={() => onRewind(checkpointId)}
          >
            <LuUndo2 size={13} aria-hidden="true" />
          </button>
        ) : null}
        <PluginSlot
          name="message.user.actions"
          props={{ content, images, messageIndex }}
        />
      </div>
      <PluginSlot
        name="message.user.after"
        props={{ content, images, messageIndex }}
      />
    </div>
  );
}

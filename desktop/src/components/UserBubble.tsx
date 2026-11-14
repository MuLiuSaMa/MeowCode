import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineImage } from "../api";
import { loadMarketplaceCatalog } from "../data/marketplaceCatalog";
import { loadPluginIconMap } from "../data/pluginIcons";
import { LuCheck, LuCopy, LuFileText, LuPuzzle, LuSparkles, LuUndo2 } from "react-icons/lu";
import { PluginSlot } from "../plugins/PluginSlot";
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
}) {
  const { t } = useTranslation("chat");
  const parsed = parseUserMessage(content);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [pluginIcons, setPluginIcons] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const copyText = parsed.body.trim() ? parsed.body : content;

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
      <div className="mc-userbubble">
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
                <LuFileText size={11} className="mc-skillchip__icon" />
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
        {parsed.body ? parsed.body : null}
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

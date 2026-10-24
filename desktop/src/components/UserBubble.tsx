import { useEffect, useState } from "react";
import type { TimelineImage } from "../api";
import { loadMarketplaceCatalog } from "../data/marketplaceCatalog";
import { LuFileText, LuPuzzle, LuSparkles } from "react-icons/lu";
import { parseUserMessage } from "../user-references";
import "./UserBubble.css";

/** 引用的附件/技能/插件各占首部一行，可连续多行；空行之后才是用户正文 */
export function UserBubble({ content, images }: { content: string; images?: TimelineImage[] }) {
  const parsed = parseUserMessage(content);
  const [icons, setIcons] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!parsed.command && parsed.chips.length === 0) {
      setIcons({});
      return;
    }
    let live = true;
    void loadMarketplaceCatalog()
      .then((catalog) => {
        if (live) setIcons(catalog.icons);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // parsed 每次渲染都是新对象，用 content 作为触发条件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  const hasChips = Boolean(parsed.command) || parsed.attachments.length > 0 || parsed.chips.length > 0;

  return (
    <div className="mc-userrow">
      <div className="mc-userbubble">
        {images?.length ? (
          <div className="mc-userbubble__images">
            {images.map((image, index) => (
              <img
                key={`${image.name ?? "img"}-${index}`}
                className="mc-userbubble__image"
                src={image.src ?? image.dataUrl}
                alt={image.name ?? "图片"}
              />
            ))}
          </div>
        ) : null}
        {hasChips ? (
          <div className="mc-userbubble__skillrow">
            {parsed.command ? (
              <span className="mc-skillchip" title={`/${parsed.command.command}`}>
                {icons[`plugin:${parsed.command.pluginId}`] ? (
                  <img
                    src={icons[`plugin:${parsed.command.pluginId}`]}
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
              const iconKey = `${chip.kind}:${chip.id}`;
              return (
                <span className="mc-skillchip" key={`${chip.kind}:${chip.id}`}>
                  {icons[iconKey] ? (
                    <img src={icons[iconKey]} alt="" className="mc-skillchip__icon" />
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
    </div>
  );
}

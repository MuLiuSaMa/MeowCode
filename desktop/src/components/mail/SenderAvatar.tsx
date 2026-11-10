import { useEffect, useState } from "react";
import { accountColor, senderAvatarUrl, senderInitial } from "./mail-meta";
import "./mail.css";

export function SenderAvatar({
  name,
  address,
  size = "sm",
}: {
  name: string;
  address: string;
  size?: "sm" | "lg";
}) {
  const [failed, setFailed] = useState(false);
  const url = senderAvatarUrl(address);
  useEffect(() => setFailed(false), [url]);

  const className = [
    "mc-mail__avatar",
    `mc-mail__avatar--${size}`,
    accountColor(address || name),
    url && !failed ? "mc-mail__avatar--image" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className}>
      {senderInitial(name, address)}
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}

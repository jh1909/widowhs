import { useState } from "react";

type PlayerAvatarProps = {
  name: string;
  avatarUrl?: string | null;
  className?: string;
};

export default function PlayerAvatar({ name, avatarUrl, className = "" }: PlayerAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = avatarUrl && avatarUrl !== failedUrl;

  return (
    <span className={`inline-flex items-center justify-center overflow-hidden shrink-0 ${className}`}>
      {showImage ? (
        <img
          src={avatarUrl}
          alt={`${name} avatar`}
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        <span aria-hidden="true">{Array.from(name).slice(0, 2).join("").toUpperCase()}</span>
      )}
    </span>
  );
}

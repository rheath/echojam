"use client";

import { useEffect, useState, type ReactNode } from "react";
import Image, { type ImageProps } from "next/image";
import styles from "./WalkScreen.module.css";

const DEFAULT_STOP_IMAGE = "/images/salem/placeholder.png";

function toSafeStopImage(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return DEFAULT_STOP_IMAGE;
  if (normalized.startsWith("/")) return normalized;
  if (normalized.startsWith("https://") || normalized.startsWith("http://")) return normalized;
  return DEFAULT_STOP_IMAGE;
}

type WalkScreenImageProps = Omit<ImageProps, "src" | "alt"> & {
  src: string | null | undefined;
  alt: string;
};

function WalkScreenImage({ src, alt, onError, ...props }: WalkScreenImageProps) {
  const safeSrc = toSafeStopImage(src);
  const [resolvedSrc, setResolvedSrc] = useState(safeSrc);

  useEffect(() => {
    setResolvedSrc(safeSrc);
  }, [safeSrc]);

  return (
    <Image
      {...props}
      src={resolvedSrc}
      alt={alt}
      onError={(event) => {
        if (resolvedSrc !== DEFAULT_STOP_IMAGE) {
          setResolvedSrc(DEFAULT_STOP_IMAGE);
        }
        onError?.(event);
      }}
    />
  );
}

export type WalkScreenStop = {
  id: string;
  title: string;
  subtitle?: string | null;
  imageSrc?: string | null;
  sourceLabel?: string | null;
  isActive?: boolean;
  onSelect?: (() => void) | null;
  ariaLabel?: string;
};

type WalkScreenProps = {
  mode: "interactive" | "locked";
  map: ReactNode;
  title: string;
  stops: WalkScreenStop[];
  featuredStop?: WalkScreenStop | null;
  remainingStops?: WalkScreenStop[];
  metaRow?: ReactNode;
  subline?: ReactNode;
  actions?: ReactNode;
  afterStops?: ReactNode;
  backControl?: ReactNode;
  mapAction?: ReactNode;
  railModal?: ReactNode;
  pageOverlay?: ReactNode;
  nowPlayingBar?: ReactNode;
  stopsInteractive?: boolean;
  blurRemainingStops?: boolean;
};

function renderStopItem(stop: WalkScreenStop, stopsInteractive: boolean) {
  const content = (
    <>
      <div className={styles.stopThumbWrap}>
        <WalkScreenImage
          src={stop.imageSrc}
          alt={stop.title}
          fill
          className={styles.stopThumb}
          unoptimized
        />
      </div>
      <div className={styles.stopText}>
        {stop.subtitle ? <div className={styles.stopSubtitle}>{stop.subtitle}</div> : null}
        <div className={`${styles.stopTitle} ${stop.isActive ? styles.stopTitleActive : ""}`}>
          {stop.title}
        </div>
        {stop.sourceLabel ? <div className={styles.stopSourceMeta}>{stop.sourceLabel}</div> : null}
      </div>
    </>
  );

  if (stopsInteractive && stop.onSelect) {
    return (
      <button
        key={stop.id}
        type="button"
        onClick={stop.onSelect}
        className={`${styles.stopItem} ${stop.isActive ? styles.stopItemActive : ""}`}
        aria-label={stop.ariaLabel}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      key={stop.id}
      className={`${styles.stopItem} ${styles.stopItemStatic} ${stop.isActive ? styles.stopItemActive : ""}`}
      aria-label={stop.ariaLabel}
    >
      {content}
    </div>
  );
}

export default function WalkScreen({
  mode,
  map,
  title,
  stops,
  featuredStop,
  remainingStops,
  metaRow,
  subline,
  actions,
  afterStops,
  backControl,
  mapAction,
  railModal,
  pageOverlay,
  nowPlayingBar,
  stopsInteractive = true,
  blurRemainingStops = false,
}: WalkScreenProps) {
  const hasSplitStops = featuredStop !== undefined || remainingStops !== undefined;
  const featuredStopToRender = hasSplitStops ? (featuredStop ?? null) : null;
  const remainingStopsToRender = hasSplitStops ? (remainingStops ?? []) : stops;
  const shouldAnchorModalToRemainingStops =
    Boolean(railModal) && blurRemainingStops && remainingStopsToRender.length > 0;

  return (
    <>
      <main className={`${styles.walkLayout} ${mode === "locked" ? styles.walkLayoutLocked : ""}`}>
        <div className={styles.mapHero}>
          {map}
          {backControl}
          {mapAction}
        </div>
        <div className={`${styles.rightRail} ${railModal ? styles.rightRailWithModal : ""}`}>
          <div className={styles.walkCard}>
            {metaRow ? <div className={styles.walkMetaRow}>{metaRow}</div> : null}
            <h1 className={styles.walkHeadline}>{title}</h1>
            {subline ? <div className={styles.walkSubline}>{subline}</div> : null}
            {actions ? <div className={styles.walkActionRow}>{actions}</div> : null}
            {featuredStopToRender ? (
              <div className={styles.featuredStopSection}>
                {renderStopItem(featuredStopToRender, stopsInteractive)}
              </div>
            ) : null}
            {remainingStopsToRender.length > 0 ? (
              <div className={styles.stopListRegion}>
                <div
                  className={`${styles.stopList} ${!stopsInteractive ? styles.stopListLocked : ""} ${
                    blurRemainingStops ? styles.stopListBlurred : ""
                  }`}
                >
                  {remainingStopsToRender.map((stop) => renderStopItem(stop, stopsInteractive))}
                </div>
                {shouldAnchorModalToRemainingStops ? (
                  <div className={styles.stopListModalLayer}>
                    <div className={styles.stopListModalBackdrop} aria-hidden="true" />
                    <div className={styles.stopListModalCard}>{railModal}</div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {afterStops}
          </div>
          {nowPlayingBar}
          {railModal && !shouldAnchorModalToRemainingStops ? (
            <div className={styles.railModalLayer}>
              <div className={styles.railModalBackdrop} aria-hidden="true" />
              <div className={styles.railModalCard}>{railModal}</div>
            </div>
          ) : null}
        </div>
      </main>
      {pageOverlay ? (
        <div className={styles.pageOverlayLayer}>
          <div className={styles.pageOverlayBackdrop} aria-hidden="true" />
          <div className={styles.pageOverlayCard}>{pageOverlay}</div>
        </div>
      ) : null}
    </>
  );
}

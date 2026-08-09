export default function HeroTour() {
  return (
    <div className="relative w-full aspect-square overflow-hidden [clip-path:url(#hero-mask)]">
      <svg className="absolute h-0 w-0" aria-hidden="true">
        <defs>
          <clipPath id="hero-mask" clipPathUnits="objectBoundingBox">
            <path d="M0 0H1V0.615476L0.869048 0.764286L0.661905 0.808333L0.502381 0.934524H0.303571L0.17619 0.861905L0 1V0Z" />
          </clipPath>
        </defs>
      </svg>
      <video
        className="h-full w-full object-cover"
        src="https://zhjrb3dyh4.ufs.sh/f/kTOk4z0nYjRrvILW2v3ZLDwEPYBzbgxfIXMFWvORT60A1Qqn"
        autoPlay
        loop
        muted
        playsInline
      />
      <div className="absolute inset-0 bg-lime-500/20" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="absolute inset-0 m-auto w-full"
        src="https://zhjrb3dyh4.ufs.sh/f/kTOk4z0nYjRr7LZBCw6yRgj6TkaiSVF8XoC7ceNnW5bDm41B"
        alt=""
      />
    </div>
  );
}

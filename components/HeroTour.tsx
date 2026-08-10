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
        src="https://zhjrb3dyh4.ufs.sh/f/kTOk4z0nYjRrJRKAKB2wlSADbdTKz26jswt5GeQNr9nuy0FZ"
        autoPlay
        loop
        muted
        playsInline
      />
    </div>
  );
}

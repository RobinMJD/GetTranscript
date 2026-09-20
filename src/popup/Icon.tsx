export function Icon({
  name,
  size = 20,
}: {
  name: "download" | "refresh" | "video" | "shield" | "file" | "alert";
  size?: number;
}) {
  const paths = {
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5" />
        <path d="M4 15v5h16v-5" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 1-2.34-5.66L21 8" />
        <path d="M21 3v5h-5" />
      </>
    ),
    video: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m10 8 6 4-6 4Z" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    file: (
      <>
        <path d="M13 3H5v18h10M13 3v5h5l-5-5M8 11h5M8 15h4" />
        <path d="M18 13v8m-3-3 3 3 3-3" />
      </>
    ),
    alert: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6m0 3v.1" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

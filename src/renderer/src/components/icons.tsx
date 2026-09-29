import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const PlusIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
export const FolderIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
)
export const ChevronIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
)
export const DownIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
)
export const CloseIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
)
export const GlobeIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </Icon>
)
export const BackIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
)
export const ForwardIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
)
export const ReloadIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
  </Icon>
)
export const SendIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Icon>
)
export const StopIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
  </Icon>
)
export const BookIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
    <path d="M4 19V5M8 7h7" />
  </Icon>
)
export const TrashIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Icon>
)
export const ShieldIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 3 5 6v6c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
)
export const ChatIcon = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
  </Icon>
)

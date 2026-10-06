import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches an error thrown while rendering, which would otherwise unmount the
 * whole app and leave the window blank. Chats live in the main process, so
 * reloading the window loses nothing.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('The window failed to render:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="welcome crashed">
        <h2>Something went wrong</h2>
        <p>{error.message}</p>
        <button className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}

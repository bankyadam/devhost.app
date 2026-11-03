import { Component, type ErrorInfo, type ReactNode } from 'react';

/** A screen that throws while rendering shows this instead of blanking the window; "Try again" re-renders it. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('screen crashed', error, info.componentStack);
  }
  override componentDidUpdate(prev: { resetKey?: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="content">
        <div className="notice bad" role="alert">
          <b>This screen hit a problem.</b> {this.state.error.message}
          <div><button className="btn sm" onClick={() => this.setState({ error: null })}>Try again</button></div>
        </div>
      </div>
    );
  }
}

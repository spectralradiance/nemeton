import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../lib/errors';

/** Keeps the shell usable if one screen throws, instead of blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
    reportError(error, 'Screen crashed');
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page-message" role="alert">
        <h1 className="page-title">Something went wrong</h1>
        <p>{this.state.error.message}</p>
        <button className="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

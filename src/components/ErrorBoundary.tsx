import { Component, Fragment } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { t } from '@/i18n';

interface Props {
  fallback?: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /**
   * Bumped by `reset()` and used as the children's `key`, so a retry remounts
   * the crashed subtree from scratch. Without it, `setState({hasError:false})`
   * re-rendered the *same* broken components, which threw again immediately —
   * a retry loop that could never recover.
   */
  resetKey: number;
}

/**
 * Error boundary implementing the component-level isolation requirement
 * (spec §11.2). A crashed component subtree is replaced with a fallback
 * while the rest of the application keeps running.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[error-boundary]', error, info);
    this.props.onError?.(error, info);
  }

  reset = () => {
    this.setState((s) => ({ hasError: false, error: null, resetKey: s.resetKey + 1 }));
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="error-fallback" role="alert">
          <div className="error-fallback-title">
            ⚠ {this.state.error?.message ?? t('error.unexpected')}
          </div>
          <button type="button" className="btn" onClick={this.reset}>
            {t('common.retry')}
          </button>
        </div>
      );
    }
    // The key must live on a single element *inside* the boundary: remounting
    // the boundary itself would be done by the parent. A keyed Fragment adds no
    // DOM node, so CSS child combinators outside are unaffected.
    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
  }
}
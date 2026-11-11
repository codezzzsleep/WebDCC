import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 出错时显示的内容；默认是一行提示 */
  fallback?: ReactNode;
  label?: string;
}

interface State {
  failed: boolean;
}

/** 局部错误边界（SPEC-M8 F2）：一处渲染失败不能拖垮整个界面 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[webdcc] ${this.props.label ?? 'render'} failed:`, error.message, info.componentStack?.slice(0, 400));
  }

  override render(): ReactNode {
    if (this.state.failed) return this.props.fallback ?? <div className="render-fallback">这条内容无法显示 · 在轨迹中查看</div>;
    return this.props.children;
  }
}

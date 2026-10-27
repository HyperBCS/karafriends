import { QueryErrorResetBoundary } from "@tanstack/react-query";
import React, { Suspense } from "react";

import { BiLoaderAlt } from "../../icons";
import Button from "../Button";
import * as styles from "./Loader.module.scss";

const Loader = () => (
  <div className={styles.loader}>
    <BiLoaderAlt />
  </div>
);

function shallowEqual(a: object, b: object): boolean {
  const aKeys = Object.keys(a) as (keyof typeof a)[];
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((key) => Object.is(a[key], b[key]))
  );
}

interface LoadErrorProps {
  // Tells the lookups below that the next try may ask the server again.
  onReset: () => void;
  // The wrapped component's props: new ones (another search, say) get a new
  // try.
  resetProps: object;
  children: React.ReactNode;
}

// Shows why a lookup failed in place of what it would have shown, with a
// button to try again, instead of taking the whole page down.
class LoadError extends React.Component<
  LoadErrorProps,
  { error: Error | null }
> {
  state = { error: null as Error | null };

  constructor(props: LoadErrorProps) {
    super(props);
    // A lookup that failed earlier (before going back to this page, say) is
    // tried again rather than showing its old error.
    props.onReset();
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prevProps: LoadErrorProps) {
    if (
      this.state.error !== null &&
      !shallowEqual(prevProps.resetProps, this.props.resetProps)
    ) {
      this.reset();
    }
  }

  reset = () => {
    this.props.onReset();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className={styles.error} role="alert">
        <p>Couldn't load this: {error.message || String(error)}</p>
        <Button onClick={this.reset}>Try again</Button>
      </div>
    );
  }
}

// Shows a spinner while the component's lookups load, and their error if
// one fails.
export const withLoader = <P extends object>(
  WrappedComponent: React.ComponentType<P>,
) => {
  const WithLoader = (props: P) => (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <LoadError onReset={reset} resetProps={props}>
          <Suspense fallback={<Loader />}>
            <WrappedComponent {...props} />
          </Suspense>
        </LoadError>
      )}
    </QueryErrorResetBoundary>
  );
  WithLoader.displayName = `withLoader(${
    WrappedComponent.displayName || WrappedComponent.name || "Component"
  })`;
  return WithLoader;
};

export default Loader;

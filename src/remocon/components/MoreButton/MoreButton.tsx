import React from "react";

import Button from "../Button";
import Loader from "../Loader";

interface Props {
  // What usePagedApiQuery returned for the list above.
  paged: {
    hasNext: boolean;
    isLoadingNext: boolean;
    nextError: Error | null;
    loadNext: () => void;
  };
}

// The "More" button under a paged list: a spinner while the next page loads,
// and why it failed if it did.
const MoreButton = ({ paged }: Props) => (
  <>
    {paged.nextError && (
      <p role="alert">Couldn't load more: {paged.nextError.message}</p>
    )}
    {paged.isLoadingNext ? (
      <Loader />
    ) : (
      paged.hasNext && (
        <Button full onClick={paged.loadNext}>
          More
        </Button>
      )
    )}
  </>
);

export default MoreButton;

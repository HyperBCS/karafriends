import React from "react";

import { t } from "../../i18n";
import Loader from "../Loader";
import { Button, InlineError } from "../ui";
import * as styles from "./MoreButton.module.scss";

interface Props {
  // Whether there's another page, and how to get it: what
  // usePagedApiQuery returned for the list above, say.
  paged: {
    hasNext: boolean;
    isLoadingNext: boolean;
    nextError: Error | null;
    loadNext: () => void;
  };
}

// The "More" button under a paged list: a spinner while the next page loads,
// and why it failed if it did.
const MoreButton = ({ paged }: Props) => {
  if (!paged.nextError && !paged.isLoadingNext && !paged.hasNext) return null;
  return (
    <div className={styles.more}>
      {paged.nextError && (
        <InlineError>
          {t("common.loadMoreFailed", { reason: paged.nextError.message })}
        </InlineError>
      )}
      {paged.isLoadingNext ? (
        <Loader />
      ) : (
        paged.hasNext && (
          <Button variant="secondary" full onClick={paged.loadNext}>
            {t("common.more")}
          </Button>
        )
      )}
    </div>
  );
};

export default MoreButton;

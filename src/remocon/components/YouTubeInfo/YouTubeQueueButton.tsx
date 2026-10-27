import React from "react";
import { graphql, useMutation } from "react-relay";

import useDownloadButtonText, {
  DOWNLOADING,
  WAITING_FOR_SERVER,
} from "../../hooks/useDownloadButtonText";
import Button from "../Button";

import { YouTubeInfoVideoInfoQuery$data } from "./__generated__/YouTubeInfoVideoInfoQuery.graphql";
import {
  YouTubeQueueButtonMutation,
  YouTubeQueueButtonMutation$variables,
} from "./__generated__/YouTubeQueueButtonMutation.graphql";

const youTubeQueueButtonMutation = graphql`
  mutation YouTubeQueueButtonMutation(
    $input: QueueYoutubeSongInput!
    $tryHeadOfQueue: Boolean!
  ) {
    queueYoutubeSong(input: $input, tryHeadOfQueue: $tryHeadOfQueue) {
      ... on QueueSongInfo {
        __typename
        eta
      }
      ... on QueueSongError {
        __typename
        reason
      }
    }
  }
`;

interface Props {
  videoId: string;
  videoInfo: YouTubeInfoVideoInfoQuery$data["youtubeVideoInfo"];
  adhocSongLyrics: string | null;
  selectedCaption: string | null;
  userIdentity: YouTubeQueueButtonMutation$variables["input"]["userIdentity"];
}

const YouTubeQueueButton = ({
  videoId,
  videoInfo,
  adhocSongLyrics,
  selectedCaption,
  userIdentity,
}: Props) => {
  if (videoInfo.__typename !== "YoutubeVideoInfo") return null;

  const defaultText = "Queue video";
  const [text, setText] = useDownloadButtonText(defaultText, {
    kind: "youtube",
    songId: videoId,
    suffix: null,
  });
  const [commit] = useMutation<YouTubeQueueButtonMutation>(
    youTubeQueueButtonMutation,
  );

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setText(WAITING_FOR_SERVER);

    console.log(`tryHeadOfQueue=${e.shiftKey}`);
    commit({
      variables: {
        input: {
          songId: videoId,
          name: videoInfo.title,
          artistName: videoInfo.author,
          playtime: videoInfo.lengthSeconds,
          userIdentity,
          adhocSongLyrics,
          captionCode: selectedCaption || null,
          gainValue: videoInfo.gainValue,
        },
        tryHeadOfQueue: e.shiftKey,
      },
      onCompleted: ({ queueYoutubeSong }) => {
        switch (queueYoutubeSong.__typename) {
          case "QueueSongInfo":
            setText(DOWNLOADING);
            break;
          case "QueueSongError":
            setText(`Error: ${queueYoutubeSong.reason}`);
            break;
        }
      },
    });
  };

  return (
    <Button disabled={text !== defaultText} onClick={onClick}>
      {text}
    </Button>
  );
};

export default YouTubeQueueButton;

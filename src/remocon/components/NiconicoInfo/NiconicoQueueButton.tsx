import React from "react";
import { graphql, useMutation } from "react-relay";

import useDownloadButtonText, {
  DOWNLOADING,
  WAITING_FOR_SERVER,
} from "../../hooks/useDownloadButtonText";
import Button from "../Button";

import { NiconicoInfoVideoInfoQuery$data } from "./__generated__/NiconicoInfoVideoInfoQuery.graphql";
import {
  NiconicoQueueButtonMutation,
  NiconicoQueueButtonMutation$variables,
} from "./__generated__/NiconicoQueueButtonMutation.graphql";

const niconicoQueueButtonMutation = graphql`
  mutation NiconicoQueueButtonMutation(
    $input: QueueNicoSongInput!
    $tryHeadOfQueue: Boolean!
  ) {
    queueNicoSong(input: $input, tryHeadOfQueue: $tryHeadOfQueue) {
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
  videoInfo: NiconicoInfoVideoInfoQuery$data["nicoVideoInfo"];
  userIdentity: NiconicoQueueButtonMutation$variables["input"]["userIdentity"];
}

const NiconicoQueueButton = ({ videoId, videoInfo, userIdentity }: Props) => {
  if (videoInfo.__typename !== "NicoVideoInfo") return null;

  const defaultText = "Queue video";
  const [text, setText] = useDownloadButtonText(defaultText, {
    kind: "nico",
    songId: videoId,
    suffix: null,
  });
  const [commit] = useMutation<NiconicoQueueButtonMutation>(
    niconicoQueueButtonMutation,
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
        },
        tryHeadOfQueue: e.shiftKey,
      },
      onCompleted: ({ queueNicoSong }) => {
        switch (queueNicoSong.__typename) {
          case "QueueSongInfo":
            setText(DOWNLOADING);
            break;
          case "QueueSongError":
            setText(`Error: ${queueNicoSong.reason}`);
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

export default NiconicoQueueButton;

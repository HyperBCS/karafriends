import React from "react";
import { graphql, useMutation } from "react-relay";

import useDownloadButtonText, {
  DOWNLOADING,
  WAITING_FOR_SERVER,
} from "../../hooks/useDownloadButtonText";
import Button from "../Button";

import { JoysoundSongPageQuery$data } from "../../pages/__generated__/JoysoundSongPageQuery.graphql";
import {
  JoysoundQueueButtonMutation,
  JoysoundQueueButtonMutation$variables,
} from "./__generated__/JoysoundQueueButtonMutation.graphql";

const joysoundQueueButtonMutation = graphql`
  mutation JoysoundQueueButtonMutation(
    $input: QueueJoysoundSongInput!
    $tryHeadOfQueue: Boolean!
  ) {
    queueJoysoundSong(input: $input, tryHeadOfQueue: $tryHeadOfQueue) {
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
  song: JoysoundSongPageQuery$data["joysoundSongDetail"];
  youtubeVideoId: string | null;
  userIdentity: JoysoundQueueButtonMutation$variables["input"]["userIdentity"];
  isRomaji: boolean;
  isDisabled: boolean;
  setDisabled: (isDisabled: boolean) => void;
}

const JoysoundQueueButton = ({
  song,
  youtubeVideoId,
  userIdentity,
  isRomaji,
  isDisabled,
  setDisabled,
}: Props) => {
  const defaultText = `Queue song${isRomaji ? " (Romaji)" : ""}`;

  const [text, setText] = useDownloadButtonText(
    defaultText,
    { kind: "joysound", songId: song.id, suffix: youtubeVideoId },
    () => setDisabled(false),
  );
  const [commit] = useMutation<JoysoundQueueButtonMutation>(
    joysoundQueueButtonMutation,
  );

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setDisabled(true);
    setText(WAITING_FOR_SERVER);

    console.log(`tryHeadOfQueue=${e.shiftKey}`);
    commit({
      variables: {
        input: {
          songId: song.id,
          name: song.name,
          playtime: null,
          artistName: song.artistName,
          userIdentity,
          isRomaji,
          youtubeVideoId,
        },
        tryHeadOfQueue: e.shiftKey,
      },
      onCompleted: ({ queueJoysoundSong }) => {
        switch (queueJoysoundSong.__typename) {
          case "QueueSongInfo":
            setText(DOWNLOADING);
            break;
          case "QueueSongError":
            setText(`Error: ${queueJoysoundSong.reason}`);
            break;
        }
      },
    });
  };

  return (
    <Button disabled={isDisabled} onClick={onClick}>
      {text}
    </Button>
  );
};

export default JoysoundQueueButton;

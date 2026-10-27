import React from "react";
import { Link, useParams } from "react-router";

import { useApiQuery } from "../../common/apiQueries";
import DamQueueButtons from "../components/DamQueueButtons";
import { withLoader } from "../components/Loader";

type RouteParams = {
  id: string;
};

const SongPage = () => {
  const params = useParams<RouteParams>();
  const song = useApiQuery("damSong", { id: params.id! });

  return (
    <div>
      <h2>{song.name}</h2>
      <Link to={`/search/artist/${song.artistName}`}>{song.artistName}</Link>
      {!!song.tieUp && <span> • {song.tieUp}</span>}
      {!!song.lyricsPreview && (
        <blockquote>{song.lyricsPreview} ...</blockquote>
      )}
      <DamQueueButtons song={song} />
    </div>
  );
};

export default withLoader(SongPage);

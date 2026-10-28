import React from "react";

import useReadings from "../hooks/useReadings";
import { reading } from "../../common/readings";

interface Props {
  text: string;
  // The kana reading, where the catalog gives one (DAM).
  yomi?: string;
}

// A title or an artist's name as the phone's Readings setting shows it: its
// reading in kana or romaji in place of the name, where there is one.
const WithReading = ({ text, yomi }: Props) => (
  <>{reading(text, yomi, useReadings()) ?? text}</>
);

export default WithReading;

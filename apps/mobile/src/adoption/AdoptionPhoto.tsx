// The adoption photos — a card's thumbnail and the ficha's hero + carousel.
//
// REACT NATIVE'S CORE <Image>, NOT `expo-image`. The ficha used to say photos
// needed `expo-image` and a store build; they never did. The app already draws
// remote photos with the core component (`cases/PetThumb.tsx`,
// `pets/OwnerFace.tsx`'s photo frame, `denuncias/EvidencePhotos.tsx`), and this
// file follows the same two rules those do:
//
//   · A STABLE `source`, memoized on the url, so a re-render does not hand
//     <Image> a new object and make it re-request the picture.
//   · A photo that fails to LOAD falls back to the paw. RN's <Image> draws
//     nothing on a failed load, and a blank box reads as "this animal has no
//     photo" — a claim about the shelter's listing made by a network blip.
//
// THE PAW IS THE DOCUMENT'S OWN PLACEHOLDER: the credential's empty photo frame
// (`OwnerFace.tsx`) draws the same glyph, in the same faint ink, on the same
// stripe ground, so an animal without a photo looks the same in both places.
//
// DECORATIVE TO A SCREEN READER on the card (the card already announces the
// name). The hero is labelled, because on the ficha the picture is content.

import { useMemo, useState } from "react";
import {
  FlatList,
  Image,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { Icon } from "../ui/Icon";
import { FONTS } from "../ui/fonts";
import { COLORS, RADIUS, SPACE, TYPE } from "../ui/theme";

/** The catalogue card's thumbnail edge, in dp. */
export const ADOPTION_THUMB_SIZE = 72;

/** The hero's width:height. 4:3 is what a phone camera shoots by default. */
const HERO_ASPECT = 4 / 3;

/**
 * A first guess at the hero's width — the kit's `Screen` pads its content by
 * `SPACE.xl2` on each side — used only until the hero measures itself. The
 * pager's pages, offsets and counter all run on the MEASURED width: a page
 * wider than the frame it snaps in drifts by the difference on every swipe.
 */
const SCREEN_GUTTER_ESTIMATE = SPACE.xl2;

function PawPlaceholder({ size, testID }: { size: number; testID: string }) {
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.placeholder, StyleSheet.absoluteFill]}
    >
      <Icon name="paw" size={size} color={COLORS.inkFaint} />
    </View>
  );
}

/** One remote picture inside a sized box; the paw when absent or broken. */
function Photo({
  uri,
  pawSize,
  label,
  testID,
}: {
  uri: string | null;
  pawSize: number;
  /** `null` = decorative. */
  label: string | null;
  testID: string;
}) {
  // The url that failed, not a flag: a refresh that brings a NEW url to the
  // same card must try it rather than keep the paw of the old one's failure.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const source = useMemo(() => (uri === null ? null : { uri }), [uri]);

  if (source === null || failedUri === uri) {
    return <PawPlaceholder size={pawSize} testID={`${testID}-fallback`} />;
  }
  return (
    <Image
      testID={testID}
      source={source}
      resizeMode="cover"
      style={StyleSheet.absoluteFill}
      accessibilityIgnoresInvertColors
      {...(label === null
        ? { accessibilityElementsHidden: true, importantForAccessibility: "no" as const }
        : { accessible: true, accessibilityLabel: label })}
      onError={() => setFailedUri(uri)}
    />
  );
}

/** The catalogue card's square thumbnail. */
export function AdoptionThumb({ uri }: { uri: string | null }) {
  return (
    <View style={styles.thumb}>
      <Photo
        uri={uri}
        pawSize={Math.round(ADOPTION_THUMB_SIZE * 0.4)}
        label={null}
        testID="adoption-thumb"
      />
    </View>
  );
}

/**
 * The ficha's hero, and a horizontal pager when there is more than one photo.
 *
 * A PLAIN PAGING FlatList, not a gallery dependency: one photo per page, the
 * page indicator under it says where you are ("2 de 5"). Swiping is the only
 * gesture; there is no zoom, which is the honest scope of "see the animal".
 */
export function AdoptionHero({ uris, petName }: { uris: readonly string[]; petName: string }) {
  const { width: windowWidth } = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const width = measured ?? Math.max(0, windowWidth - SCREEN_GUTTER_ESTIMATE * 2);
  const height = Math.round(width / HERO_ASPECT);
  const [page, setPage] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0 && next !== measured) setMeasured(next);
  };

  if (uris.length === 0) {
    return (
      <View testID="adoption-hero" onLayout={onLayout} style={[styles.hero, { height }]}>
        <PawPlaceholder size={48} testID="adoption-hero-fallback" />
      </View>
    );
  }

  if (uris.length === 1) {
    return (
      <View testID="adoption-hero" onLayout={onLayout} style={[styles.hero, { height }]}>
        <Photo
          uri={uris[0] ?? null}
          pawSize={48}
          label={`Foto de ${petName}`}
          testID="adoption-photo"
        />
      </View>
    );
  }

  const renderItem = ({ item, index }: ListRenderItemInfo<string>) => (
    <View style={{ width, height }}>
      <Photo
        uri={item}
        pawSize={48}
        label={`Foto ${index + 1} de ${uris.length} de ${petName}`}
        testID="adoption-photo"
      />
    </View>
  );

  return (
    <View style={styles.carousel}>
      <View testID="adoption-hero" onLayout={onLayout} style={[styles.hero, { height }]}>
        <FlatList
          testID="adoption-carousel"
          data={uris as string[]}
          keyExtractor={(uri, index) => `${index}-${uri}`}
          renderItem={renderItem}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          onMomentumScrollEnd={(event) => {
            const next = width === 0 ? 0 : Math.round(event.nativeEvent.contentOffset.x / width);
            setPage(Math.min(Math.max(next, 0), uris.length - 1));
          }}
        />
      </View>
      <View
        style={styles.dots}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {uris.map((uri, index) => (
          <View
            key={`${index}-${uri}`}
            style={[styles.dot, index === page ? styles.dotActive : null]}
          />
        ))}
      </View>
      <Text style={styles.pageLabel}>{`${page + 1} de ${uris.length}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.stripe,
  },
  thumb: {
    width: ADOPTION_THUMB_SIZE,
    height: ADOPTION_THUMB_SIZE,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.stripe,
    overflow: "hidden",
  },
  hero: {
    width: "100%",
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.stripe,
    overflow: "hidden",
  },
  carousel: { gap: SPACE.xs },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.border },
  dotActive: { backgroundColor: COLORS.accent },
  pageLabel: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    color: COLORS.inkMuted,
    textAlign: "center",
  },
});

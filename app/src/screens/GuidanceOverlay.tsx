/**
 * GuidanceOverlay — the single live guidance surface over the camera preview.
 *
 * Draws a centered alignment ring plus one instruction banner (optionally with
 * a countdown subtitle during an active-liveness challenge). Kept as the ONLY
 * place that shows live, per-frame guidance text — earlier revisions also drew
 * a second floating instruction box and a hint line under the action button,
 * which produced three texts updating independently and read as UI jitter.
 *
 * `resultTone` overrides the ring/banner to show a big check or cross — used
 * for a final pass/fail result (enrollment complete, verify matched/rejected)
 * that must be impossible to miss without scrolling to a panel below.
 *
 * Purely presentational; the gate/liveness/result decision is computed by the
 * caller.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

const OVAL_COLOR = '#050505';

export default function GuidanceOverlay({
  ready,
  text,
  subtitle,
  resultTone,
}: {
  /** True once the frame is good enough to auto-fire (ring turns green). */
  ready: boolean;
  /** The single instruction to show right now. */
  text: string;
  /** Optional secondary line, e.g. a liveness challenge countdown. */
  subtitle?: string;
  /** When set, shows a big check/cross and colors the ring + banner instead
   *  of the normal ready/not-ready styling. */
  resultTone?: 'success' | 'failure';
}): React.JSX.Element {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.ringWrap}>
        <View
          style={[
            styles.ring,
            ready && styles.ringReady,
            resultTone === 'success' && styles.ringSuccess,
            resultTone === 'failure' && styles.ringFailure,
          ]}>
          {resultTone ? (
            <Text
              style={[
                styles.resultIcon,
                resultTone === 'failure' && styles.resultIconFailure,
              ]}>
              {resultTone === 'success' ? '✓' : '✕'}
            </Text>
          ) : null}
        </View>
      </View>
      <View
        style={[
          styles.banner,
          ready && styles.bannerReady,
          resultTone === 'success' && styles.bannerSuccess,
          resultTone === 'failure' && styles.bannerFailure,
        ]}>
        <Text style={styles.bannerText}>{text}</Text>
        {subtitle ? (
          <Text style={styles.bannerSubtitle}>{subtitle}</Text>
        ) : null}
      </View>
    </View>
  );
}

const RING = 280;
const styles = StyleSheet.create({
  ringWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    width: RING,
    height: RING * 1.25,
    borderRadius: RING,
    borderColor: OVAL_COLOR,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Turns green the instant the face is centered — the visual cue that the
  // automatic capture / verify is firing, so no tap is needed.
  ringReady: {borderColor: '#22c55e', borderWidth: 6},
  ringSuccess: {borderColor: '#22c55e', borderWidth: 8},
  ringFailure: {borderColor: '#ef4444', borderWidth: 8},
  resultIcon: {color: '#22c55e', fontSize: 96, fontWeight: '900'},
  resultIconFailure: {color: '#ef4444'},
  banner: {
    position: 'absolute',
    bottom: 202,
    alignSelf: 'center',
    maxWidth: '84%',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    alignItems: 'center',
  },
  bannerReady: {backgroundColor: 'rgba(34,197,94,0.85)'},
  bannerSuccess: {backgroundColor: 'rgba(34,197,94,0.92)'},
  bannerFailure: {backgroundColor: 'rgba(239,68,68,0.92)'},
  bannerText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  bannerSubtitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
  },
});

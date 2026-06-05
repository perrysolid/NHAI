/**
 * DatalakeFaceAuth — offline on-device face recognition + liveness.
 *
 * Judge demo: camera gates, bundled TFLite model loading, offline enrollment,
 * dual liveness, local verification, encrypted queue, and sync→purge lifecycle.
 * The auth decision stays 100% offline.
 *
 * @format
 */
import React from 'react';
import {SafeAreaView, StatusBar, StyleSheet} from 'react-native';
import CameraScreen from './src/screens/CameraScreen';

function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <CameraScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#000'},
});

export default App;

import type {RecognitionModelId} from '../config';

export const RECOGNITION_ASSETS: Partial<Record<RecognitionModelId, number>> = {
  edgeface_s: require('../../assets/models/edgeface_s.tflite'),
};

export const LIVENESS_ASSET = require('../../assets/models/minifasnet.tflite');

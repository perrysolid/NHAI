# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# React Native & Hermes
-keep class com.facebook.react.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class com.facebook.hermes.** { *; }
-keepattributes *Annotation*
-keepattributes SourceFile,LineNumberTable
-keepclassmembers class * {
    @com.facebook.react.uimanager.annotations.ReactProp <methods>;
    @com.facebook.react.uimanager.annotations.ReactPropGroup <methods>;
    @com.facebook.react.bridge.ReactMethod <methods>;
}

# React Native Worklets Core & Vision Camera
-keep class com.swmansion.worklets.** { *; }
-keep class com.mrousavy.camera.** { *; }
-dontwarn com.mrousavy.camera.**

# TensorFlow Lite & Fast-TFLite
-keep class org.tensorflow.lite.** { *; }
-keep class ai.edge.litert.** { *; }
-keep class com.mrousavy.tflite.** { *; }
-dontwarn org.tensorflow.lite.**
-dontwarn ai.edge.litert.**

# Google ML Kit (Face Detection / Vision)
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_face.** { *; }
-dontwarn com.google.mlkit.**

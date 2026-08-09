package dev.hotel.hello;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

/** Smallest possible Activity: no AndroidX, no resources, no dependencies. */
public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView text = new TextView(this);
        text.setText("Hello from DevHotel");
        setContentView(text);
    }
}

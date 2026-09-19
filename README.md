# PrefixType

This PrefixType suffers from a lot of performance problems because of naive textarea comparison and naive DOM insertion. I recommend we replace the practice area with a canvas and use EditContext to handle IME interactions. We also need to support selection and cursor movement with mouse, touch and keyboard shortcuts like up down left right ctrl+left ctrl+right shift+up shift+down shift+left shift+right ctrl+shift+left ctrl+shift+right. Permit copy and paste in the canvas too. In short, it should try to behave like a textarea with highlighting of correct text and incorrect text. Also when there's incorrect text, it is to be highlighted red, and the subsequent practice text is pushed to the right.

Pay special attention to Unicode handling.

Pay special attention to performance. Time, measure.

The area to paste the practice text should still remain a normal textarea.

There are several trace files you can use to test your code to ensure robustness. You are also to fuzz the code for robustness too. You are to test the code in real chromium and compare with original PrefixType code.

Touch selection: make sure to match Chrome on Android behavior as much as possible including showing handles.

Test also the correctness and integrity of the database records and trace files.

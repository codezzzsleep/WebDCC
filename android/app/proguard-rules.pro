# JSON fields are explicit protocol keys. No reflective data-class serialization is used.
# CommonMark extensions are constructed directly; preserve parser node class identity.
-keepnames class org.commonmark.node.**
-keepnames class org.commonmark.ext.gfm.tables.**
